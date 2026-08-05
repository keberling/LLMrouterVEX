const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.LLMROUTER_DATA || path.join(ROOT, "data");

module.exports = {
  ROOT,
  DATA_DIR,
  PORT: Number(process.env.PORT || 8080),
  HOST: process.env.HOST || "0.0.0.0",
  /** How often to re-scan each Ollama server (ms) */
  DISCOVERY_INTERVAL_MS: Number(process.env.DISCOVERY_INTERVAL_MS || 15000),
  /** HTTP timeout for probing remote Ollama (ms) */
  PROBE_TIMEOUT_MS: Number(process.env.PROBE_TIMEOUT_MS || 4000),
  /** Default Ollama API port when only IP is provided */
  DEFAULT_OLLAMA_PORT: Number(process.env.DEFAULT_OLLAMA_PORT || 11434),
  /**
   * Max concurrent generations per backend server.
   * Extra requests wait in a FIFO queue and receive queue-position events.
   */
  MAX_CONCURRENT_PER_SERVER: Number(
    process.env.LLMROUTER_MAX_CONCURRENT_PER_SERVER || 1
  ),
  /** Optional bearer token for /v1 and /api proxy (leave empty to disable) */
  API_TOKEN: process.env.LLMROUTER_API_TOKEN || "",
  STORE_FILE: path.join(DATA_DIR, "servers.json"),
  STATS_FILE: path.join(DATA_DIR, "stats.json"),
};
