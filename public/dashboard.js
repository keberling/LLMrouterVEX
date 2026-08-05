const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setBar(el, pct) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  el.style.width = `${v}%`;
  el.classList.toggle("hot", v >= 90);
}

function renderServerCard(s) {
  const rt = s.runtime || {};
  const healthy = Boolean(rt.healthy);
  const offline = !s.enabled || !healthy;
  const models = rt.models || [];
  const loaded = rt.loaded || [];
  const loadedNames = new Set(loaded.map((m) => m.name));
  const hw = rt.hardware;
  const active = rt.load?.activeGenerations ?? 0;

  let hwHtml = `<div class="muted small">Hardware agent not installed — showing Ollama load only</div>`;
  if (hw?.gpu || hw?.gpus?.length) {
    const g = hw.gpu || hw.gpus[0];
    const util = g.utilization ?? g.util ?? null;
    const memPct =
      g.memoryPct ??
      (g.memoryUsedMb && g.memoryTotalMb
        ? Math.round((g.memoryUsedMb / g.memoryTotalMb) * 1000) / 10
        : null);
    hwHtml = `
      <div class="kv"><span>GPU</span><span class="small">${esc(g.name || "GPU")}</span></div>
      <div class="meter">
        <div class="meter-top"><span>GPU util</span><span class="mono">${util != null ? util + "%" : "—"}</span></div>
        <div class="bar"><i style="width:${util || 0}%" class="${util >= 90 ? "hot" : ""}"></i></div>
      </div>
      <div class="meter">
        <div class="meter-top"><span>VRAM</span><span class="mono">${memPct != null ? memPct + "%" : "—"}</span></div>
        <div class="bar"><i style="width:${memPct || 0}%" class="${memPct >= 90 ? "hot" : ""}"></i></div>
      </div>`;
  } else if (rt.load) {
    hwHtml = `
      <div class="kv"><span>Active gens</span><span class="mono">${active}</span></div>
      <div class="kv"><span>Loaded VRAM (Ollama)</span><span class="mono">${esc(rt.load.vramLabel || "—")}</span></div>
      <div class="kv"><span>Loaded models</span><span class="mono">${rt.load.loadedModelCount ?? 0}</span></div>`;
  }

  const modelChips = models
    .slice(0, 12)
    .map((m) => {
      const isLoaded = loadedNames.has(m.name);
      return `<span class="chip${isLoaded ? " loaded" : ""}" title="${esc(m.name)}">${esc(m.name)}${isLoaded ? " · VRAM" : ""}</span>`;
    })
    .join("");

  return `
    <article class="card${offline ? " offline" : ""}">
      <div class="card-head">
        <div>
          <h3>${esc(s.name)}</h3>
          <div class="mono small muted">${esc(s.baseUrl)}</div>
        </div>
        <span class="badge ${!s.enabled ? "muted" : healthy ? "ok" : "bad"}">
          ${!s.enabled ? "disabled" : healthy ? "online" : "offline"}
        </span>
      </div>
      <div class="kv"><span>Ollama</span><span class="mono">${esc(rt.version || "—")}</span></div>
      <div class="kv"><span>Latency</span><span class="mono">${rt.latencyMs != null ? rt.latencyMs + " ms" : "—"}</span></div>
      <div class="kv"><span>Requests / errors</span><span class="mono">${rt.stats?.requests ?? 0} / ${rt.stats?.errors ?? 0}</span></div>
      ${rt.lastError && !healthy ? `<div class="small" style="color:var(--danger)">${esc(rt.lastError)}</div>` : ""}
      ${hwHtml}
      <div class="small muted">Models (${models.length})</div>
      <div class="chips">${modelChips || '<span class="muted small">None discovered</span>'}</div>
    </article>`;
}

function renderModels(models) {
  const body = $("#model-body");
  if (!models?.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">No models discovered yet</td></tr>`;
    return;
  }
  body.innerHTML = models
    .map((m) => {
      const tags = (m.profile?.tags || []).slice(0, 6)
        .map((t) => `<span class="chip tag">${esc(t)}</span>`)
        .join(" ");
      const servers = (m.servers || [])
        .map((s) => {
          const cls = s.loaded ? "loaded" : "";
          return `<span class="chip ${cls}">${esc(s.name)}${s.loaded ? " · loaded" : ""}${s.healthy ? "" : " · down"}</span>`;
        })
        .join(" ");
      const params = m.profile?.paramsB != null ? `${m.profile.paramsB}B` : "—";
      return `<tr>
        <td><strong class="mono">${esc(m.name)}</strong></td>
        <td class="mono small">${esc(m.sizeLabel || "—")} · ${esc(params)}</td>
        <td><div class="chips">${tags || "—"}</div></td>
        <td><div class="chips">${servers}</div></td>
      </tr>`;
    })
    .join("");
}

async function loadCatalog() {
  const r = await fetch("/api/catalog");
  const data = await r.json();
  if (!data.ok) throw new Error("catalog failed");

  $("#t-servers").textContent = data.totals?.servers ?? 0;
  const healthy = data.totals?.healthy ?? 0;
  const elH = $("#t-healthy");
  elH.textContent = healthy;
  elH.className = "value " + (healthy > 0 ? "ok" : "bad");
  $("#t-models").textContent = data.totals?.models ?? 0;
  $("#t-active").textContent = data.totals?.active ?? 0;

  // Tailscale panel
  try {
    const ts = await fetch("/api/tailscale/status").then((r) => r.json());
    if (!ts.installed) {
      $("#ts-state").textContent = "Not installed";
      $("#ts-self").textContent = "—";
      $("#ts-ip").textContent = "—";
      $("#ts-peers").textContent = "—";
    } else if (!ts.running) {
      $("#ts-state").textContent = ts.backendState || "Stopped";
      $("#ts-self").textContent = ts.error || "—";
      $("#ts-ip").textContent = "—";
      $("#ts-peers").textContent = String((ts.peers || []).length);
    } else {
      $("#ts-state").textContent = "Connected";
      $("#ts-state").style.color = "var(--accent)";
      const selfName = ts.self?.dnsName || ts.self?.hostName || "this-node";
      $("#ts-self").textContent = selfName;
      $("#ts-ip").textContent = (ts.self?.ips || []).join(", ") || "—";
      const online = (ts.peers || []).filter((p) => p.online).length;
      $("#ts-peers").textContent = `${online} online / ${(ts.peers || []).length} total`;
      $("#ts-help").innerHTML = `Add GPU peers on the <a href="/servers">Servers</a> page · MagicDNS works as hostnames.`;
    }
  } catch {
    $("#ts-state").textContent = "Unavailable";
  }

  const cards = $("#server-cards");
  // Need full server list with registry fields — fetch /api/servers
  const sr = await fetch("/api/servers");
  const sdata = await sr.json();
  const servers = sdata.servers || [];

  if (!servers.length) {
    cards.innerHTML = `<div class="empty">No servers yet. <a href="/servers">Add one by IP</a>.</div>`;
  } else {
    cards.innerHTML = servers.map(renderServerCard).join("");
  }

  renderModels(data.models || []);
  $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;

  const origin = location.origin;
  $("#api-sample").textContent = `POST ${origin}/v1/chat/completions
Content-Type: application/json

{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true
}`;
}

$("#btn-refresh").addEventListener("click", async () => {
  $("#btn-refresh").disabled = true;
  try {
    await fetch("/api/refresh", { method: "POST" });
    await loadCatalog();
  } finally {
    $("#btn-refresh").disabled = false;
  }
});

loadCatalog().catch((e) => {
  $("#server-cards").innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
});
setInterval(() => {
  loadCatalog().catch(() => {});
}, 8000);
