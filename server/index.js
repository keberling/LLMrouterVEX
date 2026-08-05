const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const config = require("./config");
const store = require("./store");
const discovery = require("./discovery");
const {
  pickRoute,
  openaiToOllamaMessages,
  proxyOllamaChat,
  ollamaChunkToOpenAI,
  ollamaDoneToOpenAI,
} = require("./proxy");

store.ensureDataDir();

const app = express();
app.use(express.json({ limit: "32mb" }));
app.use(express.static(path.join(config.ROOT, "public")));

/** Optional API auth for proxy endpoints */
function requireApiToken(req, res, next) {
  if (!config.API_TOKEN) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.headers["x-api-key"] || "";
  if (token !== config.API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function refreshAll() {
  const servers = store.listServers();
  // Ensure runtime entries exist / prune removed
  const ids = new Set(servers.map((s) => s.id));
  for (const id of [...discovery.getAllRuntime().map((r) => r.id)]) {
    if (!ids.has(id)) discovery.removeRuntime(id);
  }
  await Promise.all(
    servers.map(async (s) => {
      discovery.ensureRuntime(s);
      await discovery.probeServer(s);
    })
  );
}

// ── Admin / dashboard API ───────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  const summary = discovery.catalogSummary();
  res.json({
    ok: true,
    service: "LLMrouterVEX",
    version: "1.0.0",
    totals: summary.totals,
  });
});

app.get("/api/servers", (_req, res) => {
  const registered = store.listServers();
  const runtime = discovery.getAllRuntime();
  const byId = new Map(runtime.map((r) => [r.id, r]));
  res.json({
    ok: true,
    servers: registered.map((s) => ({
      ...s,
      runtime: byId.get(s.id) || null,
    })),
  });
});

app.post("/api/servers", async (req, res) => {
  try {
    const { name, host, notes, enabled } = req.body || {};
    if (!host) return res.status(400).json({ ok: false, error: "host is required" });
    const server = store.addServer({ name, host, notes, enabled });
    discovery.ensureRuntime(server);
    await discovery.probeServer(server);
    res.status(201).json({
      ok: true,
      server: {
        ...server,
        runtime: discovery.getRuntime(server.id),
      },
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put("/api/servers/:id", async (req, res) => {
  try {
    const server = store.updateServer(req.params.id, req.body || {});
    if (!server) return res.status(404).json({ ok: false, error: "Not found" });
    discovery.ensureRuntime(server);
    await discovery.probeServer(server);
    res.json({
      ok: true,
      server: { ...server, runtime: discovery.getRuntime(server.id) },
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/servers/:id", (req, res) => {
  const ok = store.deleteServer(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: "Not found" });
  discovery.removeRuntime(req.params.id);
  res.json({ ok: true });
});

app.post("/api/servers/:id/refresh", async (req, res) => {
  const server = store.getServer(req.params.id);
  if (!server) return res.status(404).json({ ok: false, error: "Not found" });
  const rt = await discovery.probeServer(server);
  res.json({ ok: true, runtime: rt });
});

app.post("/api/refresh", async (_req, res) => {
  await refreshAll();
  res.json({ ok: true, ...discovery.catalogSummary() });
});

app.get("/api/catalog", (_req, res) => {
  res.json({ ok: true, ...discovery.catalogSummary() });
});

app.get("/api/models", (_req, res) => {
  const { models, totals } = discovery.catalogSummary();
  res.json({ ok: true, models, totals });
});

app.post("/api/route", (req, res) => {
  const { message, messages, model, think, hasImages } = req.body || {};
  const msgs =
    Array.isArray(messages) && messages.length
      ? messages
      : [{ role: "user", content: message || "" }];
  if (hasImages && msgs[0] && !msgs[0].images) {
    msgs[0].images = ["x"];
  }
  const result = pickRoute({ messages: msgs, model, think });
  if (result.error) {
    return res.status(result.status || 503).json({ ok: false, ...result });
  }
  res.json({ ok: true, ...result });
});

// ── OpenAI-compatible API ───────────────────────────────────────────

app.get("/v1/models", requireApiToken, (_req, res) => {
  const { models } = discovery.catalogSummary();
  res.json({
    object: "list",
    data: [
      {
        id: "auto",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "llmroutervex",
      },
      ...models.map((m) => ({
        id: m.name,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "ollama",
      })),
    ],
  });
});

app.post("/v1/chat/completions", requireApiToken, async (req, res) => {
  const body = req.body || {};
  const model = body.model || "auto";
  const stream = body.stream !== false; // default stream true for UX; clients can set false
  const messages = openaiToOllamaMessages(body.messages || []);
  const think = Boolean(body.think || body.reasoning);

  if (!messages.length) {
    return res.status(400).json({ error: { message: "messages required" } });
  }

  const decision = pickRoute({ messages, model, think });
  if (decision.error) {
    return res.status(decision.status || 503).json({
      error: { message: decision.error, type: "router_error" },
    });
  }

  const pick = decision.pick;
  const abort = new AbortController();
  // Only abort upstream if the *response* connection drops mid-flight
  // (do not use req "close" — it fires after the body is read)
  const onResponseClose = () => {
    if (!res.writableFinished) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }
  };
  res.on("close", onResponseClose);

  discovery.bumpActive(pick.serverId, 1);

  try {
    const ollamaRes = await proxyOllamaChat({
      baseUrl: pick.baseUrl,
      model: pick.model,
      messages,
      think,
      stream,
      signal: abort.signal,
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      discovery.recordRequest(pick.serverId, { ok: false });
      return res.status(ollamaRes.status).json({
        error: { message: text || "Upstream Ollama error" },
      });
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (!stream) {
      // Ollama non-stream response is a single JSON object
      const data = await ollamaRes.json();
      const content = data.message?.content || "";
      discovery.recordRequest(pick.serverId, {
        ok: true,
        tokensOut: data.eval_count || 0,
      });
      return res.json(
        ollamaDoneToOpenAI(
          {
            content,
            prompt_eval_count: data.prompt_eval_count,
            eval_count: data.eval_count,
          },
          { id, model: pick.model, created }
        )
      );
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Router metadata as a comment line (non-breaking for most clients)
    res.write(
      `: router ${JSON.stringify({
        model: pick.model,
        server: pick.serverName,
        serverId: pick.serverId,
        reason: decision.reason,
      })}\n\n`
    );

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let evalCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abort.signal.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.eval_count) evalCount = chunk.eval_count;
          const oa = ollamaChunkToOpenAI(chunk, {
            id,
            model: pick.model,
            created,
          });
          res.write(`data: ${JSON.stringify(oa)}\n\n`);
          if (chunk.done) {
            res.write("data: [DONE]\n\n");
          }
        } catch {
          /* skip */
        }
      }
    }
    if (!res.writableEnded) res.end();
    discovery.recordRequest(pick.serverId, { ok: true, tokensOut: evalCount });
  } catch (err) {
    discovery.recordRequest(pick.serverId, { ok: false });
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: err.message || "Proxy failed" },
      });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  } finally {
    res.off?.("close", onResponseClose);
    discovery.bumpActive(pick.serverId, -1);
  }
});

// ── Ollama-compatible chat proxy ────────────────────────────────────

app.post("/api/chat", requireApiToken, async (req, res) => {
  const body = req.body || {};
  const model = body.model || "auto";
  const messages = body.messages || [];
  const stream = body.stream !== false;
  const think = Boolean(body.think);

  if (!messages.length) {
    return res.status(400).json({ error: "messages required" });
  }

  const decision = pickRoute({ messages, model, think });
  if (decision.error) {
    return res.status(decision.status || 503).json({ error: decision.error });
  }
  const pick = decision.pick;

  const abort = new AbortController();
  const onResponseClose = () => {
    if (!res.writableFinished) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }
  };
  res.on("close", onResponseClose);

  discovery.bumpActive(pick.serverId, 1);
  try {
    const ollamaRes = await proxyOllamaChat({
      baseUrl: pick.baseUrl,
      model: pick.model,
      messages,
      think,
      stream,
      signal: abort.signal,
    });

    if (!ollamaRes.ok) {
      const text = await ollamaRes.text();
      discovery.recordRequest(pick.serverId, { ok: false });
      return res.status(ollamaRes.status).json({ error: text });
    }

    // Inject route info as first SSE-style meta for our dashboard clients
    if (stream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Router-Model", pick.model);
      res.setHeader("X-Router-Server", pick.serverName);
      res.flushHeaders?.();

      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      let evalCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (abort.signal.aborted) break;
        const text = decoder.decode(value, { stream: true });
        // track tokens if present
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.eval_count) evalCount = j.eval_count;
          } catch {
            /* ignore */
          }
        }
        res.write(text);
      }
      res.end();
      discovery.recordRequest(pick.serverId, { ok: true, tokensOut: evalCount });
    } else {
      const data = await ollamaRes.json();
      discovery.recordRequest(pick.serverId, {
        ok: true,
        tokensOut: data.eval_count || 0,
      });
      res.json(data);
    }
  } catch (err) {
    discovery.recordRequest(pick.serverId, { ok: false });
    if (!res.headersSent) {
      res.status(502).json({ error: err.message || "Proxy failed" });
    } else {
      res.end();
    }
  } finally {
    res.off?.("close", onResponseClose);
    discovery.bumpActive(pick.serverId, -1);
  }
});

// SPA-ish routes
app.get(["/servers", "/servers.html"], (_req, res) => {
  res.sendFile(path.join(config.ROOT, "public", "servers.html"));
});

// Boot
async function main() {
  // Seed localhost if no servers and local ollama responds
  if (store.listServers().length === 0) {
    try {
      const probe = await fetch("http://127.0.0.1:11434/api/version", {
        signal: AbortSignal.timeout(1500),
      });
      if (probe.ok) {
        store.addServer({
          name: "local",
          host: "127.0.0.1:11434",
          notes: "Auto-added local Ollama",
        });
        console.log("  Seeded local Ollama at 127.0.0.1:11434");
      }
    } catch {
      /* no local ollama */
    }
  }

  await refreshAll();
  setInterval(() => {
    refreshAll().catch((e) => console.warn("discovery tick failed", e.message));
  }, config.DISCOVERY_INTERVAL_MS);

  app.listen(config.PORT, config.HOST, () => {
    console.log(`\n  LLMrouterVEX`);
    console.log(`  Dashboard  → http://0.0.0.0:${config.PORT}/`);
    console.log(`  Servers    → http://0.0.0.0:${config.PORT}/servers`);
    console.log(`  OpenAI API → http://0.0.0.0:${config.PORT}/v1/chat/completions`);
    console.log(`  Ollama API → http://0.0.0.0:${config.PORT}/api/chat`);
    console.log(`  Data dir   → ${config.DATA_DIR}\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
