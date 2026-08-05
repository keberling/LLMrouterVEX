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
      const models = (rt.models || [])
        .slice(0, 8)
        .map((m) => `<span class="chip">${esc(m.name)}</span>`)
        .join("");
      return `
      <article class="card${!s.enabled || !healthy ? " offline" : ""}" data-id="${esc(s.id)}">
        <div class="card-head">
          <div>
            <h3>${esc(s.name)}</h3>
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

async function load() {
  const r = await fetch("/api/servers");
  const data = await r.json();
  renderList(data.servers || []);
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const host = $("#host").value.trim();
  const name = $("#name").value.trim();
  const notes = $("#notes").value.trim();
  const btn = $("#add-btn");
  const status = $("#add-status");
  btn.disabled = true;
  status.textContent = "Probing…";
  try {
    const r = await fetch("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, name: name || undefined, notes }),
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

load().catch((e) => toast(e.message, false));
setInterval(() => load().catch(() => {}), 10000);
