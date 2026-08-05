const { execFile } = require("child_process");
const { promisify } = require("util");
const { PROBE_TIMEOUT_MS } = require("./config");

const execFileAsync = promisify(execFile);

function isTailscaleIp(ip) {
  // Tailscale CGNAT range 100.64.0.0/10
  const m = String(ip || "").match(/^100\.(\d+)\./);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

async function runTailscale(args, timeoutMs = 5000) {
  try {
    const { stdout, stderr } = await execFileAsync("tailscale", args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "tailscale failed",
      code: err.code,
    };
  }
}

/**
 * @returns {Promise<{
 *   available: boolean,
 *   installed: boolean,
 *   running: boolean,
 *   backendState?: string,
 *   self?: object,
 *   peers?: array,
 *   error?: string
 * }>}
 */
async function getStatus() {
  const version = await runTailscale(["version"]);
  if (!version.ok && version.code === "ENOENT") {
    return {
      available: false,
      installed: false,
      running: false,
      error: "Tailscale CLI not installed",
    };
  }

  const st = await runTailscale(["status", "--json"]);
  if (!st.ok) {
    return {
      available: true,
      installed: true,
      running: false,
      error: (st.stderr || st.stdout || "tailscale status failed").trim(),
    };
  }

  let data;
  try {
    data = JSON.parse(st.stdout);
  } catch {
    return {
      available: true,
      installed: true,
      running: false,
      error: "Failed to parse tailscale status JSON",
    };
  }

  const self = data.Self || data.self || {};
  const peerMap = data.Peer || data.peer || {};
  const peers = Object.values(peerMap).map((p) => normalizePeer(p));

  const selfIps = self.TailscaleIPs || self.TailscaleIp || self.ips || [];
  const online =
    (data.BackendState || data.Backend || "") === "Running" ||
    Boolean(self.Online ?? self.online ?? true);

  return {
    available: true,
    installed: true,
    running: online,
    backendState: data.BackendState || data.Backend || null,
    magicDNSSuffix: data.MagicDNSSuffix || data.CurrentTailnet?.MagicDNSSuffix || null,
    self: {
      id: self.ID || self.StableID || null,
      hostName: self.HostName || self.DNSName || self.Name || null,
      dnsName: (self.DNSName || "").replace(/\.$/, "") || null,
      ips: selfIps,
      online: self.Online ?? true,
      os: self.OS || self.Os || null,
      relay: self.Relay || null,
    },
    peers,
    error: null,
  };
}

function normalizePeer(p) {
  const ips = p.TailscaleIPs || p.TailscaleIp || p.ips || [];
  const dnsName = (p.DNSName || "").replace(/\.$/, "") || null;
  return {
    id: p.ID || p.StableID || null,
    hostName: p.HostName || p.Name || dnsName || ips[0] || "peer",
    dnsName,
    ips,
    online: Boolean(p.Online ?? p.online),
    os: p.OS || p.Os || null,
    relay: p.Relay || null,
    tags: p.Tags || [],
  };
}

/**
 * Probe whether a peer looks like an Ollama host (port 11434 open).
 */
async function probeOllamaOnPeer(peer, port = 11434) {
  const hosts = [
    ...(peer.ips || []),
    ...(peer.dnsName ? [peer.dnsName] : []),
  ].filter(Boolean);

  for (const host of hosts) {
    const baseUrl = `http://${host}:${port}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(PROBE_TIMEOUT_MS, 2500));
      const res = await fetch(`${baseUrl}/api/version`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const ver = await res.json().catch(() => ({}));
      let models = [];
      try {
        const tags = await fetch(`${baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(2500),
        });
        if (tags.ok) {
          const data = await tags.json();
          models = (data.models || []).map((m) => m.name);
        }
      } catch {
        /* ignore */
      }
      return {
        reachable: true,
        baseUrl,
        host,
        port,
        version: ver.version || null,
        models,
      };
    } catch {
      /* try next address */
    }
  }
  return { reachable: false, host: peer.hostName, port };
}

async function listPeersWithOllama() {
  const status = await getStatus();
  if (!status.running) {
    return { ...status, ollamaPeers: [] };
  }
  const peers = status.peers || [];
  const probed = await Promise.all(
    peers.map(async (p) => {
      const ollama = await probeOllamaOnPeer(p);
      return { ...p, ollama };
    })
  );
  return {
    ...status,
    ollamaPeers: probed.filter((p) => p.ollama?.reachable),
    peers: probed,
  };
}

module.exports = {
  getStatus,
  listPeersWithOllama,
  probeOllamaOnPeer,
  isTailscaleIp,
  runTailscale,
};
