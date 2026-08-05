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

## One-line Tailscale join (router or GPU host)

Create an auth key: https://login.tailscale.com/admin/settings/keys

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \
  | sudo TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=llm-router bash
```

---

## One-line Ollama host setup (each GPU / LLM box)

On **every machine running Ollama**, allow only the router (LAN **or Tailscale IP**):

```bash
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- <ROUTER_IP>
```

Examples:

```bash
# LAN router
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- 192.168.1.20

# Tailscale router (recommended for remote boxes)
curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- 100.64.0.12
```

That script will:

1. Set `OLLAMA_HOST=0.0.0.0:11434`
2. Restart Ollama
3. Configure **UFW** so **only the router IP** can reach port **11434** (and tailnet helpers when the router IP is Tailscale)
4. Keep SSH open

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

Traffic is load-balanced across every healthy server that has that model (prefers fewer active jobs + already-loaded weights).

### Images (vision)

Send OpenAI-style image parts, or Ollama-style `images: ["<base64>"]` via `/api/chat`. Router will only pick vision-capable models.

---

## Routing behavior (summary)

| Situation | Preference |
|-----------|------------|
| Short scripts / simple Q&A | Smaller models (avoid 20B/27B) |
| Hard reasoning / long complex code | Larger models allowed |
| Images / OCR | Vision models (`qwen3-vl`, etc.) |
| Same model on many hosts | Least active + already loaded |
| Server down | Removed from candidate pool automatically |

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

## Updating

```bash
cd /opt/llmroutervex
sudo -u llmrouter git pull
sudo -u llmrouter npm install --omit=dev
sudo systemctl restart llmrouter
```

Or re-run `sudo bash deploy/install.sh`.

---

## License

MIT
