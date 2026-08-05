const {
  route,
  pickBalancedServer,
  latestUserText,
  messagesHaveImages,
  profileModel,
} = require("./modelRouter");
const discovery = require("./discovery");

function toOllamaBase64(img) {
  if (!img) return null;
  if (typeof img === "object") {
    if (img.base64) return img.base64;
    if (img.url?.startsWith("data:")) {
      const i = img.url.indexOf("base64,");
      return i >= 0 ? img.url.slice(i + 7) : null;
    }
  }
  const s = String(img);
  const idx = s.indexOf("base64,");
  if (idx >= 0) return s.slice(idx + 7);
  return s;
}

/** OpenAI chat messages → Ollama messages */
function openaiToOllamaMessages(messages) {
  return (messages || []).map((m) => {
    const out = { role: m.role || "user", content: "" };
    const images = [];

    if (typeof m.content === "string") {
      out.content = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = [];
      for (const part of m.content) {
        if (part.type === "text") texts.push(part.text || "");
        if (part.type === "image_url") {
          const url = part.image_url?.url || part.image_url;
          const b64 = toOllamaBase64(url);
          if (b64) images.push(b64);
        }
      }
      out.content = texts.join("\n");
    }

    if (Array.isArray(m.images) && m.images.length) {
      for (const img of m.images) {
        const b64 = toOllamaBase64(img);
        if (b64) images.push(b64);
      }
    }
    if (images.length) out.images = images;
    return out;
  });
}

function pickRoute({ messages, model, think }) {
  const prompt = latestUserText(messages);
  const hasImages = messagesHaveImages(messages);
  const candidates = discovery.buildCandidates();

  // Explicit model name: equalize across every healthy host that has it
  if (model && model !== "auto") {
    const matches = candidates.filter(
      (c) => c.profile.name === model || c.profile.name.startsWith(model + ":")
    );
    if (!matches.length) {
      return {
        error: `Model "${model}" not found on any healthy server`,
        status: 404,
      };
    }
    // Prefer exact name matches when several tags exist
    const exact = matches.filter((c) => c.profile.name === model);
    const pool = exact.length ? exact : matches;
    const modelName = pool[0].profile.name;
    const w = pickBalancedServer(pool, modelName) || pool[0];
    return {
      pick: {
        serverId: w.serverId,
        serverName: w.serverName,
        baseUrl: w.baseUrl,
        model: w.profile.name,
        score: w.score,
      },
      reason: `Explicit ${w.profile.name} @ ${w.serverName} — ${(w.reasons || []).slice(-1)[0] || "load-balanced"}`,
      classification: null,
      ranked: pool.slice(0, 8),
    };
  }

  const result = route(prompt, candidates, { hasImages, think: Boolean(think) });
  if (!result.pick) {
    return {
      error: result.reason || "No route available",
      status: 503,
      classification: result.classification,
      ranked: result.ranked,
    };
  }
  return result;
}

/**
 * Stream Ollama /api/chat and pipe as SSE-ish NDJSON or OpenAI SSE.
 */
async function proxyOllamaChat({
  baseUrl,
  model,
  messages,
  think = false,
  stream = true,
  signal,
}) {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream,
      think,
    }),
  });
  return res;
}

/**
 * Convert streaming Ollama chunks to OpenAI chat.completion.chunk SSE lines.
 */
function ollamaChunkToOpenAI(chunk, { id, model, created }) {
  if (chunk.done) {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
  }
  const content = chunk.message?.content || "";
  const thinking = chunk.message?.thinking || "";
  // Prefer content; include thinking only if no content this tick
  const delta = {};
  if (content) delta.content = content;
  else if (thinking) delta.content = thinking;
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: Object.keys(delta).length ? delta : {},
        finish_reason: null,
      },
    ],
  };
}

function ollamaDoneToOpenAI(final, { id, model, created }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: final.content || "",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: final.prompt_eval_count || 0,
      completion_tokens: final.eval_count || 0,
      total_tokens:
        (final.prompt_eval_count || 0) + (final.eval_count || 0),
    },
  };
}

module.exports = {
  pickRoute,
  openaiToOllamaMessages,
  proxyOllamaChat,
  ollamaChunkToOpenAI,
  ollamaDoneToOpenAI,
  toOllamaBase64,
  profileModel,
};
