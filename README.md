# LLMrouterVEX

Multi-server **Ollama** router for a small Ubuntu VM.

- Register Ollama hosts by **IP** (port defaults to `11434`)
- Auto-discover models (`/api/tags`) and loaded models (`/api/ps`)
- Smart model routing (task type + size) and **load balancing** across hosts that share a model
- Prefer already-loaded models to reduce VRAM thrash
- Dashboard with **server cards** (health, latency, models, load)
- **OpenAI-compatible** API for apps: `POST /v1/chat/completions`
- Ollama-compatible proxy: `POST /api/chat`
- Lightweight: Node.js only, JSON on disk, no database server
- **Tailscale** mesh: join the router, discover peers, add remote Ollama nodes by Tailscale IP / MagicDNS

GitHub: [keberling/LLMrouterVEX](https://github.com/keberling/LLMrouterVEX)

---

## One-line install (Ubuntu router VM)

Run on the **router VM** (the small Ubuntu box that will receive all app traffic):

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh | sudo bash
```

This installs Node, the app, **systemd auto-start**, and configures **UFW**:

- allows **SSH** (so you are not locked out)
- allows **8080/tcp** for the dashboard + API
- allows **Tailscale** interface / `100.64.0.0/10` to port 8080
- default **deny incoming** / allow outgoing
- enables UFW

Optional flags via env:

```bash
# Restrict dashboard/API to your LAN only (recommended on public clouds)
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh \
  | sudo LLMROUTER_ALLOW_FROM=192.168.1.0/24 bash

# Install + join Tailscale in one shot
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh \
  | sudo TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=llm-router bash

# LAN restrict + API token + Tailscale
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh \
  | sudo LLMROUTER_ALLOW_FROM=192.168.1.0/24 LLMROUTER_API_TOKEN='change-me' \
      TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=llm-router bash
```

Then open `http://<router-ip>:8080/` or `http://<tailscale-ip>:8080/`.

---

## One-line Tailscale join

Create an auth key: https://login.tailscale.com/admin/settings/keys

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \
  | sudo TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=llm-router bash
```

### Windows (Admin PowerShell)

**If the repo is public:**

```powershell
$env:TS_AUTHKEY='tskey-auth-XXXX'; $env:TS_HOSTNAME='gpu-box'
irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.ps1 | iex
```

**If the repo is private** (`irm` → **404 Not Found** is expected without auth). Use a local clone instead:

```powershell
# Admin PowerShell
cd $env:USERPROFILE\Documents\LLMrouterVEX   # or: git clone https://github.com/keberling/LLMrouterVEX.git
git pull
$env:TS_AUTHKEY='tskey-auth-XXXX'
$env:TS_HOSTNAME='gpu-box'
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\install-tailscale.ps1
```

Or one-liner with a GitHub token (classic PAT with `repo` scope):

```powershell
$env:TS_AUTHKEY='tskey-auth-XXXX'; $env:TS_HOSTNAME='gpu-box'
$h=@{ Authorization = "Bearer $env:GITHUB_TOKEN"; "User-Agent"="llmrouter" }
irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.ps1 -Headers $h | iex
```

> **Tip:** Settings → General → **Change repository visibility** → Public makes the simple `irm … | iex` one-liners work for everyone.

---

## One-line Ollama host setup (each GPU / LLM box)

On **every machine running Ollama**, allow only the router (LAN **or Tailscale IP**).

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- <ROUTER_IP>
```

```bash
# Tailscale router (recommended for remote boxes)
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- 100.64.0.12
```

Does: bind Ollama to `0.0.0.0:11434`, restart Ollama, **UFW** allow **11434 only from router** (+ tailnet helpers for `100.x` routers).

### Windows (Admin PowerShell)

**Public repo:**

```powershell
$env:ROUTER_IP='100.64.0.12'   # router Tailscale IP
irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex
```

Join Tailscale **and** configure Ollama in one shot:

```powershell
$env:ROUTER_IP='100.64.0.12'
$env:TS_AUTHKEY='tskey-auth-XXXX'
$env:TS_HOSTNAME='gpu-pc'
irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex
```

**Private repo (local clone — avoids 404):**

```powershell
cd $env:USERPROFILE\Documents\LLMrouterVEX
git pull
$env:ROUTER_IP='100.64.0.12'
$env:TS_AUTHKEY='tskey-auth-XXXX'   # optional
$env:TS_HOSTNAME='gpu-pc'
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\configure-ollama-host.ps1
```

Windows script does:

1. Optional Tailscale install/join (`TS_AUTHKEY`)
2. Sets **machine + user** env `OLLAMA_HOST=0.0.0.0:11434`
3. Restarts Ollama
4. **Windows Firewall** inbound TCP **11434** from the router IP  
   (and `100.64.0.0/10` when the router IP is Tailscale)
5. Prints this machine’s Tailscale IP to add on the router UI

> If Ollama was already running in the tray, fully quit it and reopen once so it reloads `OLLAMA_HOST`.

Then on the router → **Servers**:

- paste the worker **LAN IP**, **Tailscale IP**, or **MagicDNS** name, **or**
- click **Add as server** on a discovered Tailscale peer that exposes Ollama

---

## Architecture

```
Your apps  ──►  LLMrouterVEX (VM :8080)  ── Tailscale mesh ──► remote Ollama
                    │
                    ├─ discover / health every 15s
                    │
                    ├─► Ollama A  (LAN 192.168.x.10:11434)
                    ├─► Ollama B  (Tailscale 100.x.x.x:11434)
                    └─► Ollama C  (gpu-box.tailnet.ts.net:11434)
```

Use model name **`auto`** for intelligent routing, or a specific model name (e.g. `qwen3-vl:4b`) to load-balance across every healthy server that has it.

---

## Quick start (dev)

```bash
git clone https://github.com/keberling/LLMrouterVEX.git
cd LLMrouterVEX
npm install
npm start
```

Open:

- Dashboard: http://localhost:8080/
- Servers: http://localhost:8080/servers

If Ollama is running on the same machine, it is auto-seeded as `local`.

---

## Deploy on Ubuntu (details)

### Requirements

- Ubuntu 22.04 / 24.04 (small VM is fine: 1 vCPU, 1–2 GB RAM)
- Network path from router → Ollama hosts on port **11434**
- Node 18+ (installer uses Node 20)

### What the install script does

1. Install Node.js 20 if needed  
2. Install the app under `/opt/llmroutervex`  
3. Create user `llmrouter` and data dir `/var/lib/llmroutervex`  
4. Install and enable **systemd** unit `llmrouter.service`  
5. Start the service on boot  
6. Configure **UFW** (SSH + app port, deny other inbound)

### Service commands

```bash
sudo systemctl status llmrouter
sudo systemctl restart llmrouter
sudo journalctl -u llmrouter -f
```

### Environment (optional)

```bash
sudo systemctl edit llmrouter
```

```ini
[Service]
Environment=PORT=8080
Environment=HOST=0.0.0.0
Environment=LLMROUTER_DATA=/var/lib/llmroutervex
Environment=DISCOVERY_INTERVAL_MS=15000
Environment=LLMROUTER_API_TOKEN=super-secret
# Keep coding models warm in VRAM (Ollama keep_alive). Use -1 to never unload.
Environment=LLMROUTER_KEEP_ALIVE=30m
# Optional default context if client omits options.num_ctx (0 = off)
# Environment=LLMROUTER_DEFAULT_NUM_CTX=32768
# Optional org-wide system prompt when the client sends no system message
# Environment=LLMROUTER_SYSTEM_PREAMBLE=You are a careful coding assistant.
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart llmrouter
```

### Firewall notes (router VM)

| Rule | Purpose |
|------|---------|
| OpenSSH / 22 | Keep remote access |
| 8080/tcp | Dashboard + API for your apps |
| default deny incoming | Block everything else |
| default allow outgoing | Router can reach Ollama workers |

Restrict 8080 to your LAN:

```bash
sudo ufw delete allow 8080/tcp
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp comment 'LLMrouterVEX'
sudo ufw reload
```

### Firewall notes (Ollama workers)

The configure script only allows **11434 from the router IP**, not the whole world.

Test from the **router VM**:

```bash
curl http://<OLLAMA_IP>:11434/api/tags
```

---

## Add a server

1. Open **http://&lt;router&gt;:8080/servers**
2. Enter IP or `IP:11434` or full URL
3. Save — router probes immediately and lists models

API:

```bash
curl -s -X POST http://127.0.0.1:8080/api/servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"gpu1","host":"192.168.1.50"}'
```

---

## App integration (OpenAI-compatible)

```bash
curl http://ROUTER:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "auto",
    "stream": false,
    "messages": [{"role":"user","content":"Write a short PowerShell hello"}]
  }'
```

Python (OpenAI SDK):

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://ROUTER:8080/v1",
    api_key="not-needed",  # or LLMROUTER_API_TOKEN if set
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### Force a model

```json
{ "model": "qwen3:14b", "messages": [...] }
```

Traffic is load-balanced across every healthy server that has that model (prefers fewer active jobs + already-loaded weights + optional session stickiness).

### Images (vision)

Send OpenAI-style image parts, or Ollama-style `images: ["<base64>"]` via `/api/chat`. Router will only pick vision-capable models.

---

## Coding IDEs (Continue, Cursor-compatible, Cline, …)

Point the client’s **OpenAI-compatible base URL** at the router:

| Setting | Value |
|---------|--------|
| Base URL | `http://100.69.34.12:8080/v1` (your Tailscale / LAN router IP) |
| API key | any string, or `LLMROUTER_API_TOKEN` if you set one |
| Model | a real Ollama name (e.g. `qwen2.5-coder:14b`) or `auto` |

### What “memory” means (important)

Local models **do not store long-term memory inside weights**. Memory works as:

| Kind | Who owns it | How |
|------|-------------|-----|
| **Chat turns** | **Your IDE** | Plugin resends `messages[]` every request. Router is stateless. |
| **Project / codebase** | **Your IDE** | Rules files, `@codebase`, open-file context. Prefer this for coding. |
| **Warm model in VRAM** | **Router + Ollama** | Default `keep_alive=30m` (override with `LLMROUTER_KEEP_ALIVE` or body `keep_alive`). |
| **Same GPU for a thread** | **Router** | Send header `X-LLM-Session: <stable-id>` so multi-turn sticks to one host (better for warm VRAM / cache). |

Example with session stickiness + longer keep-alive:

```bash
curl http://ROUTER:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-LLM-Session: my-ide-chat-42' \
  -d '{
    "model": "qwen2.5-coder:14b",
    "keep_alive": "1h",
    "options": { "num_ctx": 32768 },
    "messages": [
      {"role":"system","content":"You are a coding assistant for this repo."},
      {"role":"user","content":"Explain the auth middleware."}
    ]
  }'
```

Passthrough to Ollama:

- `keep_alive` (body or env default)
- `options` (`num_ctx`, `temperature`, …)
- OpenAI fields mapped: `temperature`, `top_p`, `max_tokens` → `num_predict`, `stop`, `seed`

**Continue.dev sketch** (`~/.continue/config.json` / config.yaml): use provider OpenAI, `apiBase` → `http://ROUTER:8080/v1`, model name matching a pulled Ollama tag. Put repo rules under Continue rules / docs so project memory stays in the IDE.

**Cursor:** use a custom OpenAI-compatible endpoint where supported; keep **project rules** and Cursor’s own index for codebase memory (the router will not index your repo).

### Optional router-wide coding preamble

If you want every client that omits a system message to get the same default:

```ini
Environment=LLMROUTER_SYSTEM_PREAMBLE=You are a careful senior engineer. Prefer small diffs and explain tradeoffs briefly.
```

Prefer **per-project IDE rules** over a global preamble when repos differ.

---

## Routing behavior (summary)

| Situation | Preference |
|-----------|------------|
| Short scripts / simple Q&A | Smaller models (avoid 20B/27B) |
| Hard reasoning / long complex code | Larger models allowed |
| Images / OCR | Vision models (`qwen3-vl`, etc.) |
| Model already in VRAM on a host | **Use that host** (don’t cold-load elsewhere) |
| Same model loaded on several hosts | Equalize by active jobs, then request counts, then RR |
| Nobody has it loaded yet | Equalize cold-starts across hosts |
| Loaded hosts all saturated (`active ≥ 3`) | May spill to an idle host (cold load) |
| Server down | Removed from candidate pool automatically |

Env: `LLMROUTER_MAX_ACTIVE_BEFORE_COLD_SPILL=3` (default) controls when a busy VRAM-resident host may spill to a cold peer.

---

## Hardware stats

Cards always show:

- Online/offline, latency, Ollama version  
- Discovered models + which are loaded in VRAM  
- Active generations, request/error counters  

Optional **agent** (future / custom): if `http://<host>:9100/stats` returns GPU/CPU JSON, the dashboard will render utilization bars. Without an agent, VRAM estimates come from Ollama’s loaded models (`/api/ps`).

---

## API reference (admin)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health + totals |
| GET | `/api/servers` | Registered servers + live runtime |
| POST | `/api/servers` | Add server `{ host, name?, notes? }` |
| PUT | `/api/servers/:id` | Update / enable / disable |
| DELETE | `/api/servers/:id` | Remove |
| POST | `/api/servers/:id/refresh` | Probe one host now |
| POST | `/api/refresh` | Probe all |
| GET | `/api/catalog` | Servers + model catalog |
| GET | `/api/models` | Aggregated models |
| POST | `/api/route` | Preview routing decision |
| POST | `/v1/chat/completions` | OpenAI-compatible proxy |
| GET | `/v1/models` | OpenAI model list |
| POST | `/api/chat` | Ollama-compatible proxy |

---

## Project layout

```
LLMrouterVEX/
  server/
    index.js        # HTTP API + proxy
    store.js        # server registry (JSON)
    discovery.js    # probes + runtime stats
    modelRouter.js  # scoring / model choice
    proxy.js        # OpenAI ↔ Ollama
    config.js
  public/           # dashboard UI
  deploy/
    install.sh
    llmrouter.service
  data/             # created at runtime (gitignored)
```

---

## Updating the Ubuntu router VM

**One-liner (recommended):** re-runs install (pulls latest `main`, `npm install`, restarts service, refreshes UFW):

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh | sudo bash
```

If you ever see `fatal: detected dubious ownership in repository at '/opt/llmroutervex'`, either re-run the one-liner above (fixed in recent installs) or:

```bash
sudo git config --global --add safe.directory /opt/llmroutervex
sudo chown -R root:root /opt/llmroutervex
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh | sudo bash
```

**Or manual:**

```bash
sudo git config --global --add safe.directory /opt/llmroutervex
cd /opt/llmroutervex
sudo git fetch origin main
sudo git reset --hard origin/main
sudo npm install --omit=dev
sudo chown -R llmrouter:llmrouter /opt/llmroutervex /var/lib/llmroutervex
sudo systemctl restart llmrouter
sudo systemctl status llmrouter --no-pager
```

Logs:

```bash
sudo journalctl -u llmrouter -f
```

Your registered servers in `/var/lib/llmroutervex` are **kept** across updates.

---

## License

MIT

