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
  /** Default Whisper / OpenAI-STT port when kind=stt and only IP is provided */
  DEFAULT_STT_PORT: Number(process.env.DEFAULT_STT_PORT || 8090),
  /**
   * Optional single STT backend (OpenAI-compatible Whisper).
   * Example: http://gpu-box:8090/v1
   * Apps still call THIS router at /v1/audio/transcriptions.
   */
  STT_BACKEND_URL: (process.env.STT_BACKEND_URL || "").replace(/\/$/, ""),
  /** openai | whisper.cpp | auto */
  STT_BACKEND_API: process.env.STT_BACKEND_API || "auto",
  /**
   * Max concurrent generations per backend server.
   * Extra requests wait in a FIFO queue and receive queue-position events.
   */
  MAX_CONCURRENT_PER_SERVER: Number(
    process.env.LLMROUTER_MAX_CONCURRENT_PER_SERVER || 1
  ),
  /**
   * How long Ollama keeps a model in VRAM after a request.
   * Ollama formats: "30m", "1h", number of seconds, or "-1" (stay loaded).
   * Empty string = let Ollama default (usually ~5m).
   */
  KEEP_ALIVE:
    process.env.LLMROUTER_KEEP_ALIVE !== undefined
      ? process.env.LLMROUTER_KEEP_ALIVE
      : "30m",
  /**
   * Default context window if the client does not send options.num_ctx.
   * 0 / empty = do not inject (use model/Ollama default).
   */
  DEFAULT_NUM_CTX: Number(process.env.LLMROUTER_DEFAULT_NUM_CTX || 0) || 0,
  /**
   * Optional system preamble prepended when the request has no system message.
   * Useful as an org-wide coding default; prefer IDE project rules for repos.
   */
  SYSTEM_PREAMBLE: process.env.LLMROUTER_SYSTEM_PREAMBLE || "",
  /**
   * How long session sticky affinity lives (ms) after last use.
   * Clients send header X-LLM-Session (or body.session_id).
   */
  SESSION_STICKY_TTL_MS: Number(
    process.env.LLMROUTER_SESSION_STICKY_TTL_MS || 30 * 60 * 1000
  ),
  /** Optional bearer token for /v1 and /api proxy (leave empty to disable) */
  API_TOKEN: process.env.LLMROUTER_API_TOKEN || "",
  STORE_FILE: path.join(DATA_DIR, "servers.json"),
  STATS_FILE: path.join(DATA_DIR, "stats.json"),
};
