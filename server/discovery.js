const { PROBE_TIMEOUT_MS, MAX_CONCURRENT_PER_SERVER } = require("./config");
const { profileModel } = require("./modelRouter");

/**
 * Runtime state for all registered servers (not persisted).
 * Map<serverId, ServerRuntime>
 */
const runtime = new Map();

/** active generation counts per serverId */
const activeByServer = new Map();

/**
 * Per-server FIFO slot queues.
 * Map<serverId, { active: number, max: number, waiters: Array }>
 */
const serverQueues = new Map();

function getQueue(serverId) {
  let q = serverQueues.get(serverId);
  if (!q) {
    q = {
      active: 0,
      max: MAX_CONCURRENT_PER_SERVER,
      waiters: [],
    };
    serverQueues.set(serverId, q);
  }
  return q;
}

function queueSnapshot(serverId) {
  const q = getQueue(serverId);
  const rt = runtime.get(serverId);
  return {
    serverId,
    serverName: rt?.name || serverId,
    active: q.active,
    waiting: q.waiters.length,
    maxConcurrent: q.max,
    /** 0 = running / about to run; 1+ = place in line (1 = next) */
    // position filled by callers for a specific waiter
  };
}

function notifyWaiters(serverId) {
  const q = getQueue(serverId);
  const base = queueSnapshot(serverId);
  q.waiters.forEach((w, idx) => {
    if (typeof w.onUpdate === "function") {
      try {
        w.onUpdate({
          ...base,
          status: "waiting",
          position: idx + 1,
          ahead: idx,
          message:
            idx === 0
              ? `Next in line on ${base.serverName}…`
              : `Queued on ${base.serverName} — ${idx} ahead of you`,
        });
      } catch {
        /* ignore listener errors */
      }
    }
  });
}

function pumpQueue(serverId) {
  const q = getQueue(serverId);
  while (q.active < q.max && q.waiters.length > 0) {
    const next = q.waiters.shift();
    q.active += 1;
    activeByServer.set(serverId, q.active);
    const rt = runtime.get(serverId);
    if (rt?.load) rt.load.activeGenerations = q.active;

    const release = () => {
      q.active = Math.max(0, q.active - 1);
      activeByServer.set(serverId, q.active);
      if (rt?.load) rt.load.activeGenerations = q.active;
      pumpQueue(serverId);
      notifyWaiters(serverId);
    };

    try {
      next.resolve(release);
    } catch {
      release();
    }
  }
  notifyWaiters(serverId);
}

/**
 * Wait for a concurrency slot on a backend server.
 * @param {string} serverId
 * @param {{ signal?: AbortSignal, onUpdate?: (snap)=>void }} opts
 * @returns {Promise<() => void>} release function
 */
function acquireServerSlot(serverId, opts = {}) {
  const { signal, onUpdate } = opts;
  const q = getQueue(serverId);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }

    const entry = {
      resolve,
      reject,
      onUpdate,
    };

    const onAbort = () => {
      const idx = q.waiters.indexOf(entry);
      if (idx >= 0) {
        q.waiters.splice(idx, 1);
        notifyWaiters(serverId);
      }
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Immediate start if capacity free
    if (q.active < q.max && q.waiters.length === 0) {
      q.active += 1;
      activeByServer.set(serverId, q.active);
      const rt = runtime.get(serverId);
      if (rt?.load) rt.load.activeGenerations = q.active;

      if (typeof onUpdate === "function") {
        onUpdate({
          ...queueSnapshot(serverId),
          status: "starting",
          position: 0,
          ahead: 0,
          message: `Starting on ${rt?.name || "server"}…`,
        });
      }

      const release = () => {
        q.active = Math.max(0, q.active - 1);
        activeByServer.set(serverId, q.active);
        if (rt?.load) rt.load.activeGenerations = q.active;
        if (signal) signal.removeEventListener("abort", onAbort);
        pumpQueue(serverId);
      };
      resolve(release);
      return;
    }

    // Must wait
    q.waiters.push(entry);
    notifyWaiters(serverId);
    // entry.resolve is called from pumpQueue with release fn
    const origResolve = entry.resolve;
    entry.resolve = (release) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (typeof onUpdate === "function") {
        onUpdate({
          ...queueSnapshot(serverId),
          status: "starting",
          position: 0,
          ahead: 0,
          message: `Your turn — starting on ${queueSnapshot(serverId).serverName}…`,
        });
      }
      origResolve(release);
    };
  });
}

function getQueueDepth(serverId) {
  const q = getQueue(serverId);
  return {
    active: q.active,
    waiting: q.waiters.length,
    maxConcurrent: q.max,
  };
}

function emptyRuntime(server) {
  return {
    id: server.id,
    name: server.name,
    baseUrl: server.baseUrl,
    host: server.host,
    port: server.port,
    enabled: server.enabled,
    healthy: false,
    lastError: null,
    lastProbeAt: null,
    latencyMs: null,
    version: null,
    models: [],
    loaded: [],
    hardware: null,
    stats: {
      requests: 0,
      errors: 0,
      tokensOut: 0,
      lastRequestAt: null,
    },
  };
}

function ensureRuntime(server) {
  let rt = runtime.get(server.id);
  if (!rt) {
    rt = emptyRuntime(server);
    runtime.set(server.id, rt);
  }
  // keep name/url in sync with registry
  rt.name = server.name;
  rt.baseUrl = server.baseUrl;
  rt.host = server.host;
  rt.port = server.port;
  rt.enabled = server.enabled;
  return rt;
}

function removeRuntime(serverId) {
  runtime.delete(serverId);
  activeByServer.delete(serverId);
  serverQueues.delete(serverId);
}

function isModelLoaded(serverId, modelName) {
  const rt = runtime.get(serverId);
  if (!rt) return false;
  return (rt.loaded || []).some((m) => m.name === modelName);
}

function describePick(pick) {
  const depth = getQueueDepth(pick.serverId);
  const loaded = isModelLoaded(pick.serverId, pick.model);
  const willQueue = depth.active >= depth.maxConcurrent;
  return {
    serverId: pick.serverId,
    serverName: pick.serverName,
    baseUrl: pick.baseUrl,
    model: pick.model,
    modelLoaded: loaded,
    willQueue,
    queue: {
      ...depth,
      status: willQueue ? "waiting" : "starting",
      position: willQueue ? depth.waiting + 1 : 0,
      ahead: willQueue ? depth.waiting : 0,
      message: willQueue
        ? `Queued on ${pick.serverName} — ${depth.waiting} ahead · ${pick.model}${loaded ? " (in VRAM)" : " (cold load)"}`
        : `${loaded ? "Using" : "Loading"} ${pick.model} on ${pick.serverName}…`,
    },
  };
}

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { data, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe optional lightweight metrics endpoint on the host:
 *   GET http://host:port/api/router-stats  (custom)
 *   or GET http://host:9100/metrics       (future agent)
 * Falls back to Ollama-only info.
 */
async function probeHardware(baseUrl) {
  // Optional companion agent (if user deploys one later)
  try {
    const u = new URL(baseUrl);
    const agentUrl = `${u.protocol}//${u.hostname}:9100/stats`;
    const { data } = await fetchJson(agentUrl, 1500);
    if (data && (data.cpu != null || data.gpu || data.memory)) {
      return {
        source: "agent",
        cpuPercent: data.cpu ?? data.cpuPercent ?? null,
        memoryUsedMb: data.memoryUsedMb ?? data.memUsedMb ?? null,
        memoryTotalMb: data.memoryTotalMb ?? data.memTotalMb ?? null,
        gpu: data.gpu || null,
        gpus: data.gpus || (data.gpu ? [data.gpu] : []),
        hostname: data.hostname || null,
        uptimeSec: data.uptimeSec ?? null,
      };
    }
  } catch {
    /* no agent */
  }
  return null;
}

async function probeServer(server) {
  const rt = ensureRuntime(server);
  if (!server.enabled) {
    rt.healthy = false;
    rt.lastError = "disabled";
    rt.lastProbeAt = new Date().toISOString();
    return rt;
  }

  const base = server.baseUrl.replace(/\/$/, "");
  try {
    const [versionRes, tagsRes, psRes] = await Promise.all([
      fetchJson(`${base}/api/version`).catch(() => null),
      fetchJson(`${base}/api/tags`),
      fetchJson(`${base}/api/ps`).catch(() => ({ data: { models: [] }, latencyMs: null })),
    ]);

    const latencyMs = tagsRes.latencyMs;
    const models = (tagsRes.data.models || []).map((m) => {
      const profile = profileModel(m);
      return {
        name: m.name,
        size: m.size,
        sizeLabel: formatBytes(m.size),
        modifiedAt: m.modified_at || null,
        details: m.details || {},
        capabilities: m.capabilities || profile.capabilities,
        profile,
      };
    });

    const loaded = (psRes.data?.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      sizeVram: m.size_vram,
      sizeLabel: formatBytes(m.size),
      sizeVramLabel: formatBytes(m.size_vram),
      expiresAt: m.expires_at || null,
      contextLength: m.context_length || null,
      details: m.details || {},
    }));

    let hardware = null;
    try {
      hardware = await probeHardware(base);
    } catch {
      hardware = null;
    }

    // Derive coarse "load" from loaded model VRAM + active gens
    const active = activeByServer.get(server.id) || 0;
    const vramUsed = loaded.reduce((s, m) => s + (m.sizeVram || 0), 0);

    rt.healthy = true;
    rt.lastError = null;
    rt.lastProbeAt = new Date().toISOString();
    rt.latencyMs = latencyMs;
    rt.version = versionRes?.data?.version || null;
    rt.models = models;
    rt.loaded = loaded;
    rt.hardware = hardware;
    rt.load = {
      activeGenerations: active,
      loadedModelCount: loaded.length,
      vramBytes: vramUsed,
      vramLabel: formatBytes(vramUsed),
    };
    return rt;
  } catch (err) {
    rt.healthy = false;
    rt.lastError = err.message || "probe failed";
    rt.lastProbeAt = new Date().toISOString();
    rt.models = [];
    rt.loaded = [];
    return rt;
  }
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getRuntime(serverId) {
  return runtime.get(serverId) || null;
}

function getAllRuntime() {
  return [...runtime.values()];
}

function bumpActive(serverId, delta) {
  const cur = activeByServer.get(serverId) || 0;
  activeByServer.set(serverId, Math.max(0, cur + delta));
  const rt = runtime.get(serverId);
  if (rt?.load) {
    rt.load.activeGenerations = activeByServer.get(serverId) || 0;
  }
}

function recordRequest(serverId, { ok, tokensOut = 0 } = {}) {
  const rt = runtime.get(serverId);
  if (!rt) return;
  rt.stats.requests += 1;
  if (!ok) rt.stats.errors += 1;
  if (tokensOut) rt.stats.tokensOut += tokensOut;
  rt.stats.lastRequestAt = new Date().toISOString();
}

/**
 * Build flat candidate list for the router from healthy servers.
 */
function buildCandidates() {
  const out = [];
  for (const rt of runtime.values()) {
    if (!rt.enabled || !rt.healthy) continue;
    const loadedNames = new Set((rt.loaded || []).map((m) => m.name));
    const active = activeByServer.get(rt.id) || 0;
    const totalRequests = rt.stats?.requests || 0;
    for (const m of rt.models || []) {
      out.push({
        serverId: rt.id,
        serverName: rt.name,
        baseUrl: rt.baseUrl,
        profile: m.profile || profileModel(m),
        loaded: loadedNames.has(m.name),
        active,
        totalRequests,
        statsRequests: totalRequests,
        latencyMs: rt.latencyMs,
        healthy: true,
        weight: 1,
      });
    }
  }
  return out;
}

function catalogSummary() {
  const servers = getAllRuntime();
  const modelMap = new Map(); // name -> { name, servers: [], ... }

  for (const rt of servers) {
    for (const m of rt.models || []) {
      if (!modelMap.has(m.name)) {
        modelMap.set(m.name, {
          name: m.name,
          profile: m.profile,
          sizeLabel: m.sizeLabel,
          capabilities: m.capabilities,
          servers: [],
        });
      }
      const entry = modelMap.get(m.name);
      entry.servers.push({
        id: rt.id,
        name: rt.name,
        baseUrl: rt.baseUrl,
        healthy: rt.healthy,
        loaded: (rt.loaded || []).some((l) => l.name === m.name),
        latencyMs: rt.latencyMs,
        active: activeByServer.get(rt.id) || 0,
      });
    }
  }

  return {
    servers,
    models: [...modelMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    totals: {
      servers: servers.length,
      healthy: servers.filter((s) => s.healthy).length,
      models: modelMap.size,
      active: [...activeByServer.values()].reduce((a, b) => a + b, 0),
    },
  };
}

module.exports = {
  ensureRuntime,
  removeRuntime,
  probeServer,
  getRuntime,
  getAllRuntime,
  bumpActive,
  recordRequest,
  buildCandidates,
  catalogSummary,
  formatBytes,
  activeByServer,
  acquireServerSlot,
  getQueueDepth,
  isModelLoaded,
  describePick,
  queueSnapshot,
};
