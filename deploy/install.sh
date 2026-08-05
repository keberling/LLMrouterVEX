#!/usr/bin/env bash
# Install LLMrouterVEX on Ubuntu for auto-start via systemd.
# Run as root:  sudo bash deploy/install.sh
set -euo pipefail

APP_NAME="llmroutervex"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
SERVICE_USER="llmrouter"
REPO_URL="${REPO_URL:-https://github.com/keberling/LLMrouterVEX.git}"
BRANCH="${BRANCH:-main}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root: sudo bash deploy/install.sh"
  exit 1
fi

echo "==> Installing Node.js 20 (NodeSource) if needed"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  apt-get update -y
  apt-get install -y git ca-certificates
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
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
elif [[ -f "$APP_DIR/package.json" ]]; then
  echo "   (existing package.json found — skipping clone)"
else
  # Support install from a copied tree (current dir) or git clone
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SOURCE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
  if [[ -f "${SOURCE_ROOT}/package.json" ]]; then
    rsync -a --delete --exclude node_modules --exclude data "${SOURCE_ROOT}/" "${APP_DIR}/"
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
fi

cd "$APP_DIR"
npm install --omit=dev

chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR" "$DATA_DIR"

echo "==> Installing systemd unit"
cp "$APP_DIR/deploy/llmrouter.service" /etc/systemd/system/llmrouter.service
systemctl daemon-reload
systemctl enable llmrouter.service
systemctl restart llmrouter.service

sleep 1
systemctl --no-pager --full status llmrouter.service || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================================"
echo " LLMrouterVEX installed"
echo " Dashboard:  http://${IP:-<vm-ip>}:8080/"
echo " Servers:    http://${IP:-<vm-ip>}:8080/servers"
echo " OpenAI API: http://${IP:-<vm-ip>}:8080/v1/chat/completions"
echo " Data:       ${DATA_DIR}"
echo " Logs:       journalctl -u llmrouter -f"
echo "============================================================"
echo ""
echo "On each Ollama host, expose the API, e.g.:"
echo "  sudo mkdir -p /etc/systemd/system/ollama.service.d"
echo "  echo -e '[Service]\nEnvironment=\"OLLAMA_HOST=0.0.0.0:11434\"' | sudo tee /etc/systemd/system/ollama.service.d/override.conf"
echo "  sudo systemctl daemon-reload && sudo systemctl restart ollama"
echo ""
