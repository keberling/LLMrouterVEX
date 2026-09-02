#!/usr/bin/env bash
# Install a local OpenAI-compatible Whisper STT server for LLMrouterVEX.
#
# Run on a GPU box (or the router VM for CPU/tiny models):
#   curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-whisper.sh \
#     | sudo bash -s -- <ROUTER_IP>
#
# Optional env:
#   PORT=8090
#   WHISPER_MODEL=base          # tiny | base | small | medium | large-v3
#   WHISPER_DEVICE=auto         # auto | cuda | cpu
#
# Then on the router UI → Servers → Kind: Whisper STT → host <this-ip>:8090
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use the curl | sudo bash one-liner)."
  exit 1
fi

ROUTER_IP="${1:-${ROUTER_IP:-}}"
PORT="${PORT:-8090}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"
WHISPER_DEVICE="${WHISPER_DEVICE:-auto}"
APP_DIR="/opt/llmrouter-whisper"
SERVICE_USER="whisper"
REPO_URL="${REPO_URL:-https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/whisper-openai-server.py}"

if [[ -z "$ROUTER_IP" ]]; then
  echo "Usage: $0 <ROUTER_IP>"
  echo "ROUTER_IP = the LLMrouterVEX host (LAN IP or Tailscale 100.x IP)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
echo "==> Installing ffmpeg + python3 venv"
apt-get update -y
apt-get install -y python3 python3-venv python3-pip ffmpeg ca-certificates curl

echo "==> Creating service user"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$APP_DIR"
echo "==> Fetching Whisper OpenAI server"
if [[ -f "$(dirname "$0")/whisper-openai-server.py" ]]; then
  cp "$(dirname "$0")/whisper-openai-server.py" "$APP_DIR/server.py"
else
  curl -fsSL "$REPO_URL" -o "$APP_DIR/server.py"
fi
chmod 644 "$APP_DIR/server.py"

echo "==> Python venv + faster-whisper"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --upgrade pip
"$APP_DIR/venv/bin/pip" install "faster-whisper" "fastapi" "uvicorn" "python-multipart"

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
systemctl enable --now llmrouter-whisper.service

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
TS_IP="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null || true)"
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
echo "   Host: ${TS_IP:-${HOST_IP}}:${PORT}"
echo ""
echo " Or set on the router VM:"
echo "   Environment=STT_BACKEND_URL=http://${TS_IP:-${HOST_IP}}:${PORT}/v1"
echo ""
echo " Test from router:"
echo "   curl http://${TS_IP:-${HOST_IP}}:${PORT}/health"
echo "============================================================"
