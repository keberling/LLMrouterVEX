const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast ${ok ? "ok" : "error"}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function renderList(servers) {
  const root = $("#server-list");
  $("#count-label").textContent = `${servers.length} registered`;
  if (!servers.length) {
    root.innerHTML = `<div class="empty">No servers yet — add one above.</div>`;
    return;
  }
  root.innerHTML = servers
    .map((s) => {
      const rt = s.runtime || {};
      const healthy = Boolean(rt.healthy);
      const kind = s.kind || rt.kind || "ollama";
      const models = (rt.models || [])
        .slice(0, 8)
        .map((m) => `<span class="chip">${esc(m.name)}</span>`)
        .join("");
      return `
      <article class="card${!s.enabled || !healthy ? " offline" : ""}" data-id="${esc(s.id)}">
        <div class="card-head">
          <div>
            <h3>${esc(s.name)} <span class="chip">${esc(kind === "stt" ? "STT" : "Ollama")}</span></h3>
            <div class="mono small muted">${esc(s.baseUrl)}</div>
          </div>
          <span class="badge ${!s.enabled ? "muted" : healthy ? "ok" : "bad"}">
            ${!s.enabled ? "disabled" : healthy ? "online" : "offline"}
          </span>
        </div>
        ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}
        <div class="kv"><span>Latency</span><span class="mono">${rt.latencyMs != null ? rt.latencyMs + " ms" : "—"}</span></div>
        <div class="kv"><span>Models</span><span class="mono">${rt.models?.length ?? 0}</span></div>
        ${rt.lastError && !healthy ? `<div class="small" style="color:var(--danger)">${esc(rt.lastError)}</div>` : ""}
        <div class="chips">${models || ""}</div>
        <div class="card-actions">
          <button class="btn" data-action="refresh" type="button">Probe</button>
          <button class="btn" data-action="toggle" type="button">${s.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-danger" data-action="delete" type="button">Remove</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderTailscale(data) {
  const root = $("#ts-peers");
  const label = $("#ts-label");
  if (!data || !data.installed) {
    label.textContent = "not installed";
    root.innerHTML = `<div class="empty">Tailscale not installed on this router.
      <div class="help" style="margin-top:10px">
        <code class="mono">curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh | sudo TS_AUTHKEY=tskey-auth-XXXX bash</code>
      </div>
    </div>`;
    return;
  }
  if (!data.running) {
    label.textContent = data.backendState || "offline";
    root.innerHTML = `<div class="empty">Tailscale installed but not connected.
      <div class="help" style="margin-top:8px">${esc(data.error || "Run: sudo tailscale up")}</div>
    </div>`;
    return;
  }

  const peers = data.peers || [];
  const withOllama = peers.filter((p) => p.ollama?.reachable);
  const online = peers.filter((p) => p.online).length;
  label.textContent = `${withOllama.length} Ollama · ${online}/${peers.length} peers online`;

  if (!peers.length) {
    root.innerHTML = `<div class="empty">No Tailscale peers yet. Join GPU hosts to the same tailnet.</div>`;
    return;
  }

  root.innerHTML = peers
    .map((p) => {
      const ip = (p.ips || [])[0] || "";
      const ollama = p.ollama || {};
      const models = (ollama.models || [])
        .slice(0, 6)
        .map((m) => `<span class="chip">${esc(m)}</span>`)
        .join("");
      return `
      <article class="card${!p.online ? " offline" : ""}">
        <div class="card-head">
          <div>
            <h3>${esc(p.hostName)}</h3>
            <div class="mono small muted">${esc(p.dnsName || ip || "—")}</div>
          </div>
          <span class="badge ${p.online ? "ok" : "bad"}">${p.online ? "online" : "offline"}</span>
        </div>
        <div class="kv"><span>Tailscale IP</span><span class="mono">${esc(ip || "—")}</span></div>
        <div class="kv"><span>Ollama</span><span class="mono">${ollama.reachable ? esc(ollama.version || "yes") : "not detected"}</span></div>
        <div class="chips">${models || (ollama.reachable ? "" : '<span class="muted small">No /api/tags on :11434</span>')}</div>
        <div class="card-actions">
          <button class="btn btn-primary" type="button" data-ts-add
            data-ip="${esc(ip)}"
            data-dns="${esc(p.dnsName || "")}"
            data-name="${esc(p.hostName)}"
            ${ollama.reachable ? "" : "disabled"}
          >Add as server</button>
        </div>
      </article>`;
    })
    .join("");
}

async function loadTailscale() {
  try {
    const data = await fetch("/api/tailscale").then((r) => r.json());
    renderTailscale(data);
  } catch (err) {
    $("#ts-label").textContent = "error";
    $("#ts-peers").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function load() {
  const r = await fetch("/api/servers");
  const data = await r.json();
  renderList(data.servers || []);
  await loadTailscale();
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const host = $("#host").value.trim();
  const name = $("#name").value.trim();
  const notes = $("#notes").value.trim();
  const kind = $("#kind")?.value || "ollama";
  const btn = $("#add-btn");
  const status = $("#add-status");
  btn.disabled = true;
  status.textContent = "Probing…";
  try {
    const r = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, name: name || undefined, notes, kind }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "Failed");
    toast(`Added ${data.server.name}`, true);
    $("#add-form").reset();
    status.textContent = data.server.runtime?.healthy
      ? "Online — models discovered"
      : "Saved (host offline or Ollama not reachable yet)";
    await load();
  } catch (err) {
    status.textContent = "";
    toast(err.message || "Add failed", false);
  } finally {
    btn.disabled = false;
  }
});

document.body.addEventListener("click", async (e) => {
  const addTs = e.target.closest("[data-ts-add]");
  if (addTs) {
    e.preventDefault();
    const ip = addTs.getAttribute("data-ip");
    const dns = addTs.getAttribute("data-dns");
    const name = addTs.getAttribute("data-name");
    addTs.disabled = true;
    try {
      const r = await fetch("/api/tailscale/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: ip || undefined,
          dnsName: dns || undefined,
          host: ip || dns,
          name: name || undefined,
          port: 11434,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Add failed");
      toast(`Added ${data.server.name}`, true);
      await load();
    } catch (err) {
      toast(err.message || "Add failed", false);
    } finally {
      addTs.disabled = false;
    }
    return;
  }
});

$("#server-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const card = btn.closest("[data-id]");
  const id = card?.getAttribute("data-id");
  if (!id) return;
  const action = btn.getAttribute("data-action");

  try {
    if (action === "delete") {
      if (!confirm("Remove this server from the router?")) return;
      const r = await fetch(`/api/servers/${id}`, { method: "DELETE" });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Delete failed");
      toast("Server removed", true);
    }
    if (action === "refresh") {
      btn.disabled = true;
      await fetch(`/api/servers/${id}/refresh`, { method: "POST" });
      toast("Probed", true);
    }
    if (action === "toggle") {
      const list = await fetch("/api/servers").then((r) => r.json());
      const s = (list.servers || []).find((x) => x.id === id);
      if (!s) return;
      await fetch(`/api/servers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      toast(s.enabled ? "Disabled" : "Enabled", true);
    }
    await load();
  } catch (err) {
    toast(err.message || "Action failed", false);
  } finally {
    btn.disabled = false;
  }
});

const kindEl = $("#kind");
if (kindEl) {
  kindEl.addEventListener("change", () => {
    const help = $("#host-help");
    if (!help) return;
    if (kindEl.value === "stt") {
      help.innerHTML =
        'Port defaults to <strong>8090</strong> for Whisper. Run <code class="mono">deploy/install-whisper.sh</code> on a GPU box, then add that host here.';
    } else {
      help.innerHTML =
        "Port defaults to <strong>11434</strong> for Ollama, <strong>8090</strong> for Whisper. Use LAN IP, <strong>Tailscale IP</strong>, or MagicDNS name.";
    }
  });
}

load().catch((e) => toast(e.message, false));
setInterval(() => load().catch(() => {}), 10000);
