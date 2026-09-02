/**
 * OpenAI-compatible speech-to-text proxy.
 *
 * Apps (Voice Portal, etc.) POST /v1/audio/transcriptions on this router.
 * The router forwards to a local Whisper backend — never a cloud vendor.
 *
 * Backends:
 *   1. STT_BACKEND_URL env (OpenAI-compatible or whisper.cpp)
 *   2. Registered servers with kind=stt
 */

const config = require("./config");
const discovery = require("./discovery");

const TRANSCRIBE_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 180000);

function stripSlash(url) {
  return String(url || "").replace(/\/$/, "");
}

function openaiTranscriptionUrl(baseUrl) {
  const b = stripSlash(baseUrl);
  if (b.endsWith("/v1")) return `${b}/audio/transcriptions`;
  if (b.endsWith("/audio/transcriptions")) return b;
  return `${b}/v1/audio/transcriptions`;
}

function whisperCppUrl(baseUrl) {
  const b = stripSlash(baseUrl).replace(/\/v1$/, "");
  if (b.endsWith("/inference")) return b;
  return `${b}/inference`;
}

function listSttTargets() {
  const targets = [];
  if (config.STT_BACKEND_URL) {
    targets.push({
      id: "env",
      name: "STT_BACKEND_URL",
      baseUrl: config.STT_BACKEND_URL,
      sttApi: config.STT_BACKEND_API || "auto",
      healthy: true,
    });
  }
  for (const rt of discovery.getAllRuntime()) {
    if ((rt.kind || "ollama") !== "stt") continue;
    if (!rt.enabled) continue;
    targets.push({
      id: rt.id,
      name: rt.name,
      baseUrl: rt.baseUrl,
      sttApi: rt.sttApi || "auto",
      healthy: Boolean(rt.healthy),
      serverId: rt.id,
    });
  }
  const healthy = targets.filter((t) => t.healthy);
  return healthy.length ? healthy : targets;
}

function pickSttTarget() {
  const targets = listSttTargets();
  if (!targets.length) return null;
  return targets.find((t) => t.healthy) || targets[0];
}

function sttStatus() {
  const targets = listSttTargets();
  return {
    configured: targets.length > 0,
    env: Boolean(config.STT_BACKEND_URL),
    backends: targets.map((t) => ({
      id: t.id,
      name: t.name,
      baseUrl: t.baseUrl,
      api: t.sttApi,
      healthy: t.healthy,
    })),
  };
}

function missingSttError() {
  const err = new Error(
    "STT is not configured on LLMrouterVEX. Register a Whisper host (kind=stt) on /servers, or set STT_BACKEND_URL (e.g. http://gpu-box:8090/v1). See deploy/install-whisper.sh."
  );
  err.status = 503;
  return err;
}

function extractText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload !== "object") return String(payload).trim();
  const direct = payload.text || payload.transcript || payload.transcription;
  if (direct) return String(direct).trim();
  if (payload.data && typeof payload.data === "object") {
    const nested = payload.data.text || payload.data.transcript;
    if (nested) return String(nested).trim();
  }
  if (Array.isArray(payload.segments)) {
    return payload.segments
      .map((s) => s.text || s.segment || "")
      .join(" ")
      .trim();
  }
  return "";
}

async function postMultipart(url, { buffer, filename, contentType, fields, signal }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === "") continue;
    form.append(k, String(v));
  }
  const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });
  form.append("file", blob, filename || "audio.wav");

  const res = await fetch(url, { method: "POST", body: form, signal });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { ok: res.ok, status: res.status, json, raw };
}

async function transcribeOpenAI(target, audio, signal) {
  const url = openaiTranscriptionUrl(target.baseUrl);
  return postMultipart(url, {
    buffer: audio.buffer,
    filename: audio.filename,
    contentType: audio.contentType,
    fields: {
      model: audio.model || "whisper-1",
      language: audio.language,
      response_format: audio.responseFormat || "json",
      temperature: audio.temperature,
    },
    signal,
  });
}

async function transcribeWhisperCpp(target, audio, signal) {
  const url = whisperCppUrl(target.baseUrl);
  return postMultipart(url, {
    buffer: audio.buffer,
    filename: audio.filename,
    contentType: audio.contentType,
    fields: {
      temperature: audio.temperature || "0.0",
      response_format: "json",
      language: audio.language,
    },
    signal,
  });
}

async function transcribeWithTarget(target, audio, signal) {
  const api = (target.sttApi || "auto").toLowerCase();
  if (api === "whisper.cpp" || api === "whispercpp") {
    return transcribeWhisperCpp(target, audio, signal);
  }
  if (api === "openai") {
    return transcribeOpenAI(target, audio, signal);
  }
  const first = await transcribeOpenAI(target, audio, signal);
  if (first.ok || (first.status !== 404 && first.status !== 405)) {
    return first;
  }
  return transcribeWhisperCpp(target, audio, signal);
}

/**
 * @param {{ buffer: Buffer, filename?: string, contentType?: string, model?: string, language?: string, responseFormat?: string, temperature?: string }} audio
 * @returns {Promise<{ text: string, model: string, backend: object, raw: any }>}
 */
async function transcribe(audio) {
  const target = pickSttTarget();
  if (!target) throw missingSttError();
  if (!audio?.buffer?.length) {
    const err = new Error("file is required");
    err.status = 400;
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
  let releaseSlot = null;
  try {
    if (target.serverId) {
      releaseSlot = await discovery.acquireServerSlot(target.serverId, {
        signal: ctrl.signal,
      });
    }
    const result = await transcribeWithTarget(target, audio, ctrl.signal);
    if (target.serverId) {
      discovery.recordRequest(target.serverId, { ok: result.ok });
    }
    if (!result.ok) {
      const detail =
        (result.json && (result.json.error?.message || result.json.error || result.json.detail)) ||
        result.raw ||
        `HTTP ${result.status}`;
      const err = new Error(
        `STT backend ${target.name} failed (${result.status}): ${String(detail).slice(0, 500)}`
      );
      err.status = result.status >= 400 ? result.status : 502;
      throw err;
    }
    const text = extractText(result.json);
    if (!text) {
      const err = new Error("STT backend returned empty transcript");
      err.status = 502;
      throw err;
    }
    return {
      text,
      model: audio.model || "whisper-1",
      backend: { id: target.id, name: target.name, baseUrl: target.baseUrl },
      raw: result.json,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error("STT request timed out");
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (typeof releaseSlot === "function") {
      try {
        releaseSlot();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  transcribe,
  sttStatus,
  listSttTargets,
  pickSttTarget,
  openaiTranscriptionUrl,
  whisperCppUrl,
};
