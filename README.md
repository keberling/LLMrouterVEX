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

GitHub: [keberling/LLMrouterVEX](https://github.com/keberling/LLMrouterVEX)

---

## Architecture

```
Your apps  ──►  LLMrouterVEX (VM :8080)
                    │
                    ├─ discover / health every 15s
                    │
                    ├─► Ollama A  (192.168.x.10:11434)
                    ├─► Ollama B  (192.168.x.11:11434)
                    └─► Ollama C  ...
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

## Deploy on Ubuntu (auto-start)

### Requirements

- Ubuntu 22.04 / 24.04 (small VM is fine: 1 vCPU, 1–2 GB RAM)
- Outbound/inbound access to Ollama hosts on port **11434**
- Node 18+ (installer uses Node 20)

### One-shot install

From a git checkout of this repo:

```bash
sudo bash deploy/install.sh
```

This will:

1. Install Node.js 20 if needed  
2. Install the app under `/opt/llmroutervex`  
3. Create user `llmrouter` and data dir `/var/lib/llmroutervex`  
4. Install and enable **systemd** unit `llmrouter.service`  
5. Start the service on boot  

### Service commands

```bash
sudo systemctl status llmrouter
sudo systemctl restart llmrouter
sudo journalctl -u llmrouter -f
```

### Environment (optional)

Edit the unit or use a drop-in:

```bash
sudo systemctl edit llmrouter
```

```ini
[Service]
Environment=PORT=8080
Environment=HOST=0.0.0.0
Environment=LLMROUTER_DATA=/var/lib/llmroutervex
Environment=DISCOVERY_INTERVAL_MS=15000
# Optional shared secret for /v1 and /api/chat:
# Environment=LLMROUTER_API_TOKEN=super-secret
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart llmrouter
```

### Firewall

```bash
sudo ufw allow 8080/tcp
sudo ufw reload
```

---

## Configure Ollama hosts (required)

By default Ollama only listens on `127.0.0.1`. On **each** worker machine:

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Allow the router VM to reach it:

```bash
sudo ufw allow from <ROUTER_VM_IP> to any port 11434
```

Test from the router VM:

```bash
curl http://<OLLAMA_IP>:11434/api/tags
```

---

## Add a server

1. Open **http://&lt;router&gt;:8080/servers**
2. Enter IP or `IP:11434` or full URL
3. Save — router probes immediately and lists models

You can also use the API:

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
