#!/usr/bin/env bash
# Install LLMrouterVEX on Ubuntu for auto-start via systemd + UFW.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install.sh | sudo bash
#
# Optional env:
#   PORT=8080
#   LLMROUTER_ALLOW_FROM=192.168.1.0/24   # restrict dashboard/API to a subnet
#   LLMROUTER_API_TOKEN=secret            # require Bearer token on /v1 and /api/chat
#   TS_AUTHKEY=tskey-auth-...             # join Tailscale during install
#   TS_HOSTNAME=llm-router
#   BRANCH=main
#   REPO_URL=https://github.com/keberling/LLMrouterVEX.git
set -euo pipefail

APP_NAME="llmroutervex"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
SERVICE_USER="llmrouter"
REPO_URL="${REPO_URL:-https://github.com/keberling/LLMrouterVEX.git}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-8080}"
ALLOW_FROM="${LLMROUTER_ALLOW_FROM:-}"
API_TOKEN="${LLMROUTER_API_TOKEN:-}"
TS_AUTHKEY="${TS_AUTHKEY:-}"
TS_HOSTNAME="${TS_HOSTNAME:-llm-router}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use the curl | sudo bash one-liner)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages (git, curl, ufw, rsync, Node 20 if needed)"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync ufw

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v(1[89]|[2-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Node $(node -v) / npm $(npm -v)"

echo "==> Creating service user"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "==> Installing app into ${APP_DIR}"
mkdir -p "$APP_DIR" "$DATA_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/${BRANCH}" 2>/dev/null \
    || git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/${BRANCH}" 2>/dev/null \
    || git -C "$APP_DIR" pull --ff-only origin "$BRANCH" || true
else
  SCRIPT_PATH="${BASH_SOURCE[0]:-}"
  SOURCE_ROOT=""
  if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && "$SCRIPT_PATH" != /dev/fd/* ]]; then
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    CANDIDATE="$(cd "${SCRIPT_DIR}/.." && pwd)"
    if [[ -f "${CANDIDATE}/package.json" ]]; then
      SOURCE_ROOT="$CANDIDATE"
    fi
  fi

  if [[ -n "$SOURCE_ROOT" ]]; then
    rsync -a --delete \
      --exclude node_modules \
      --exclude data \
      --exclude .git \
      "${SOURCE_ROOT}/" "${APP_DIR}/"
  else
    rm -rf "${APP_DIR}.tmp-clone"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "${APP_DIR}.tmp-clone"
    rsync -a --delete \
      --exclude node_modules \
      --exclude data \
      "${APP_DIR}.tmp-clone/" "${APP_DIR}/"
    rm -rf "${APP_DIR}.tmp-clone"
  fi
fi

cd "$APP_DIR"
npm install --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

echo "==> Installing systemd unit"
cp "$APP_DIR/deploy/llmrouter.service" /etc/systemd/system/llmrouter.service

# Optional runtime env drop-in
mkdir -p /etc/systemd/system/llmrouter.service.d
{
  echo "[Service]"
  echo "Environment=PORT=${PORT}"
  echo "Environment=HOST=0.0.0.0"
  echo "Environment=LLMROUTER_DATA=${DATA_DIR}"
  if [[ -n "$API_TOKEN" ]]; then
    echo "Environment=LLMROUTER_API_TOKEN=${API_TOKEN}"
  fi
} > /etc/systemd/system/llmrouter.service.d/override.conf

systemctl daemon-reload
systemctl enable llmrouter.service
systemctl restart llmrouter.service

echo "==> Configuring UFW firewall (accessible + safe defaults)"
# Never lock yourself out of SSH
if ss -lnt | grep -qE ':22\s'; || systemctl is-active --quiet ssh 2>/dev/null || systemctl is-active --quiet sshd 2>/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp comment 'OpenSSH' >/dev/null 2>&1 || true
else
  ufw allow 22/tcp comment 'OpenSSH' >/dev/null 2>&1 || true
fi

# Dashboard / API port
if [[ -n "$ALLOW_FROM" ]]; then
  # Restrict app port to a trusted network or host
  ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow from "$ALLOW_FROM" to any port "$PORT" proto tcp comment 'LLMrouterVEX' >/dev/null 2>&1 || \
    ufw allow from "$ALLOW_FROM" to any port "$PORT" proto tcp >/dev/null
  echo "   Port ${PORT}/tcp allowed only from ${ALLOW_FROM}"
else
  ufw allow "${PORT}/tcp" comment 'LLMrouterVEX' >/dev/null 2>&1 || \
    ufw allow "${PORT}/tcp" >/dev/null
  echo "   Port ${PORT}/tcp open (set LLMROUTER_ALLOW_FROM=CIDR to restrict)"
fi

# Always allow Tailscale interface / CGNAT for mesh access
ufw allow in on tailscale0 to any port "${PORT}" proto tcp comment 'LLMrouterVEX Tailscale' >/dev/null 2>&1 || true
ufw allow from 100.64.0.0/10 to any port "${PORT}" proto tcp comment 'LLMrouterVEX tailnet' >/dev/null 2>&1 || true

# Default policies if ufw was never configured
ufw default deny incoming >/dev/null 2>&1 || true
ufw default allow outgoing >/dev/null 2>&1 || true

# Enable without interactive prompt (SSH rule already present)
if ! ufw status | grep -qi "Status: active"; then
  ufw --force enable
else
  ufw reload >/dev/null 2>&1 || true
fi

echo "==> UFW status"
ufw status numbered || true

# Optional Tailscale join during install
if [[ -n "$TS_AUTHKEY" ]]; then
  echo "==> Joining Tailscale (TS_AUTHKEY provided)"
  if [[ -f "$APP_DIR/deploy/install-tailscale.sh" ]]; then
    bash "$APP_DIR/deploy/install-tailscale.sh" || true
  else
    curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \
      | TS_AUTHKEY="$TS_AUTHKEY" TS_HOSTNAME="$TS_HOSTNAME" bash || true
  fi
fi

sleep 1
systemctl --no-pager --full status llmrouter.service || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TS_IP="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null || true)"
echo ""
echo "============================================================"
echo " LLMrouterVEX installed + enabled on boot"
echo " Dashboard:  http://${IP:-<vm-ip>}:${PORT}/"
if [[ -n "$TS_IP" ]]; then
  echo " Tailscale:  http://${TS_IP}:${PORT}/"
fi
echo " Servers:    http://${IP:-${TS_IP:-<vm-ip>}}:${PORT}/servers"
echo " OpenAI API: http://${IP:-${TS_IP:-<vm-ip>}}:${PORT}/v1/chat/completions"
echo " Data:       ${DATA_DIR}"
echo " Logs:       journalctl -u llmrouter -f"
echo " Firewall:   UFW active · SSH + :${PORT} (+ Tailscale if present)"
echo "============================================================"
echo ""
if [[ -z "$TS_AUTHKEY" ]]; then
  echo "Optional Tailscale join (router VM):"
  echo "  curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \\"
  echo "    | sudo TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=${TS_HOSTNAME} bash"
  echo ""
fi
echo "On EACH Ollama worker (LAN or Tailscale IP of this router):"
echo "  curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh \\"
echo "    | sudo bash -s -- ${TS_IP:-${IP:-ROUTER_IP}}"
echo ""
