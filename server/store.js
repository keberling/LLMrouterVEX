const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DATA_DIR, STORE_FILE } = require("./config");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    const initial = { servers: [], updatedAt: new Date().toISOString() };
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { servers: [], updatedAt: new Date().toISOString() };
  }
}

function writeStore(store) {
  ensureDataDir();
  store.updatedAt = new Date().toISOString();
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_FILE);
}

function listServers() {
  return readStore().servers || [];
}

function getServer(id) {
  return listServers().find((s) => s.id === id) || null;
}

function normalizeKind(kind) {
  const k = String(kind || "ollama").toLowerCase().trim();
  return k === "stt" || k === "whisper" ? "stt" : "ollama";
}

function defaultPortForKind(kind) {
  const config = require("./config");
  return kind === "stt" ? config.DEFAULT_STT_PORT : config.DEFAULT_OLLAMA_PORT;
}

function normalizeHost(input, { defaultPort } = {}) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Host is required");
  // Allow full URL or bare IP/hostname
  if (!/^https?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid host/URL");
  }
  if (!url.port) {
    url.port = String(defaultPort || require("./config").DEFAULT_OLLAMA_PORT);
  }
  // Origin without trailing slash (path like /v1 is ignored; we add API paths)
  const baseUrl = `${url.protocol}//${url.hostname}:${url.port}`;
  return {
    baseUrl,
    host: url.hostname,
    port: Number(url.port),
  };
}

function addServer({
  name,
  host,
  enabled = true,
  notes = "",
  kind = "ollama",
  sttApi = "auto",
}) {
  const kindNorm = normalizeKind(kind);
  const norm = normalizeHost(host, { defaultPort: defaultPortForKind(kindNorm) });
  const store = readStore();
  const duplicate = store.servers.find(
    (s) => s.baseUrl.toLowerCase() === norm.baseUrl.toLowerCase()
  );
  if (duplicate) {
    throw new Error(`Server already registered: ${norm.baseUrl}`);
  }
  const server = {
    id: randomUUID(),
    name: (name || norm.host).trim(),
    host: norm.host,
    port: norm.port,
    baseUrl: norm.baseUrl,
    kind: kindNorm,
    sttApi: kindNorm === "stt" ? String(sttApi || "auto") : undefined,
    enabled: Boolean(enabled),
    notes: notes || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.servers.push(server);
  writeStore(store);
  return server;
}

function updateServer(id, patch = {}) {
  const store = readStore();
  const idx = store.servers.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const current = store.servers[idx];
  let next = { ...current };

  if (patch.name != null) next.name = String(patch.name).trim();
  if (patch.notes != null) next.notes = String(patch.notes);
  if (patch.enabled != null) next.enabled = Boolean(patch.enabled);
  if (patch.kind != null) next.kind = normalizeKind(patch.kind);
  if (patch.sttApi != null) next.sttApi = String(patch.sttApi || "auto");
  if (patch.host != null && String(patch.host).trim()) {
    const kind = patch.kind != null ? normalizeKind(patch.kind) : next.kind || "ollama";
    const norm = normalizeHost(patch.host, {
      defaultPort: defaultPortForKind(kind),
    });
    next.host = norm.host;
    next.port = norm.port;
    next.baseUrl = norm.baseUrl;
  }
  next.updatedAt = new Date().toISOString();
  store.servers[idx] = next;
  writeStore(store);
  return next;
}

function deleteServer(id) {
  const store = readStore();
  const before = store.servers.length;
  store.servers = store.servers.filter((s) => s.id !== id);
  if (store.servers.length === before) return false;
  writeStore(store);
  return true;
}

module.exports = {
  listServers,
  getServer,
  addServer,
  updateServer,
  deleteServer,
  normalizeHost,
  normalizeKind,
  ensureDataDir,
};
