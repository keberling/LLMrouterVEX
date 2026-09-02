#!/usr/bin/env bash
# Install a local OpenAI-compatible Whisper STT server for LLMrouterVEX.
#
# Run on a GPU / LLM box (Ubuntu/Debian) — not on Windows (use install-whisper.ps1).
#
#   curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-whisper.sh \
#     | sudo bash -s -- 100.69.34.12
#
# Optional env:
#   PORT=8090
#   WHISPER_MODEL=base          # tiny | base | small | medium | large-v3
#   WHISPER_DEVICE=cpu          # cpu is the reliable default; set cuda if NVIDIA stack works
#
# Then on the router UI → Servers → Kind: Whisper STT → host <this-ip>:8090
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use the curl | sudo bash one-liner)."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  cat <<'EOF'
This script is for Ubuntu/Debian.

On a Windows LLM box (Admin PowerShell):
  $env:ROUTER_IP='100.69.34.12'
  irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-whisper.ps1 | iex
EOF
  exit 1
fi

ROUTER_IP="${1:-${ROUTER_IP:-}}"
PORT="${PORT:-8090}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"
WHISPER_DEVICE="${WHISPER_DEVICE:-cpu}"
APP_DIR="/opt/llmrouter-whisper"
SERVICE_USER="whisper"
SERVER_PY_URL="${SERVER_PY_URL:-https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/whisper-openai-server.py}"

if [[ -z "$ROUTER_IP" ]]; then
  echo "Usage: $0 <ROUTER_IP>"
  echo "ROUTER_IP = the LLMrouterVEX host (LAN IP or Tailscale 100.x IP)."
  echo "Example: sudo bash $0 100.69.34.12"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
echo "==> Installing ffmpeg + python venv + ctranslate2 libs"
apt-get update -y
apt-get install -y \
  python3 python3-venv python3-pip python3-dev \
  ffmpeg ca-certificates curl \
  libgomp1 gcc

echo "==> Creating service user"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" || \
    useradd --system --shell /usr/sbin/nologin "$SERVICE_USER"
fi
getent group "$SERVICE_USER" >/dev/null 2>&1 || groupadd --system "$SERVICE_USER"
usermod -a -G "$SERVICE_USER" "$SERVICE_USER" >/dev/null 2>&1 || true

mkdir -p "$APP_DIR"
echo "==> Fetching Whisper OpenAI server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "${SCRIPT_DIR:-}" && -f "${SCRIPT_DIR}/whisper-openai-server.py" ]]; then
  cp "${SCRIPT_DIR}/whisper-openai-server.py" "$APP_DIR/server.py"
else
  curl -fsSL "$SERVER_PY_URL" -o "$APP_DIR/server.py"
fi
chmod 644 "$APP_DIR/server.py"
head -1 "$APP_DIR/server.py" | grep -q python || {
  echo "Failed to download whisper-openai-server.py"
  exit 1
}

echo "==> Python venv + faster-whisper"
rm -rf "$APP_DIR/venv"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip wheel
if ! "$APP_DIR/venv/bin/pip" install "faster-whisper" "fastapi" "uvicorn" "python-multipart"; then
  echo "pip install failed. Retrying once…"
  "$APP_DIR/venv/bin/pip" install "faster-whisper" "fastapi" "uvicorn" "python-multipart"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> systemd unit"
cat > /etc/systemd/system/llmrouter-whisper.service <<EOF
[Unit]
Description=LLMrouterVEX local Whisper STT (OpenAI-compatible)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
Environment=WHISPER_MODEL=${WHISPER_MODEL}
Environment=WHISPER_DEVICE=${WHISPER_DEVICE}
ExecStart=${APP_DIR}/venv/bin/python ${APP_DIR}/server.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable llmrouter-whisper.service
if ! systemctl restart llmrouter-whisper.service; then
  echo "ERROR: llmrouter-whisper.service failed to start"
  journalctl -u llmrouter-whisper -n 80 --no-pager || true
  exit 1
fi
sleep 2
if ! systemctl is-active --quiet llmrouter-whisper.service; then
  echo "ERROR: llmrouter-whisper.service is not active"
  systemctl --no-pager -l status llmrouter-whisper.service || true
  journalctl -u llmrouter-whisper -n 80 --no-pager || true
  exit 1
fi

echo "==> Local health check"
if ! curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health"; then
  echo
  echo "Service is running but /health did not respond yet. Logs:"
  journalctl -u llmrouter-whisper -n 40 --no-pager || true
fi
echo

echo "==> Firewall: allow ${PORT}/tcp from router ${ROUTER_IP}"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow from "$ROUTER_IP" to any port "$PORT" proto tcp comment 'LLMrouterVEX STT' || true
  if [[ "$ROUTER_IP" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
    ufw allow in on tailscale0 to any port "$PORT" proto tcp comment 'STT Tailscale' >/dev/null 2>&1 || true
    ufw allow from 100.64.0.0/10 to any port "$PORT" proto tcp comment 'STT tailnet' >/dev/null 2>&1 || true
  fi
  if ! ufw status | grep -qi "Status: active"; then
    ufw --force enable
  else
    ufw reload >/dev/null 2>&1 || true
  fi
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TS_IP="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true)"
ADD_HOST="${TS_IP:-${HOST_IP}}"
echo ""
echo "============================================================"
echo " Whisper STT ready for LLMrouterVEX"
echo " LAN IP:        ${HOST_IP:-unknown}"
echo " Tailscale IP:  ${TS_IP:-not joined}"
echo " Listen:        0.0.0.0:${PORT}"
echo " Model:         ${WHISPER_MODEL} (${WHISPER_DEVICE})"
echo " Allowed from:  ${ROUTER_IP}"
echo ""
echo " On the router UI → Servers:"
echo "   Kind: Whisper STT"
echo "   Host: ${ADD_HOST}:${PORT}"
echo ""
echo " Or on the router VM:"
echo "   sudo systemctl edit llmrouter"
echo "   [Service]"
echo "   Environment=STT_BACKEND_URL=http://${ADD_HOST}:${PORT}/v1"
echo "   sudo systemctl daemon-reload && sudo systemctl restart llmrouter"
echo ""
echo " Test from router (${ROUTER_IP}):"
echo "   curl http://${ADD_HOST}:${PORT}/health"
echo "============================================================"
