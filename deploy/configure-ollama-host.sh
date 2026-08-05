#!/usr/bin/env bash
# Configure this machine's Ollama to accept connections from LLMrouterVEX.
#
# One-liner (run on each Ollama GPU host):
#   curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh | sudo bash -s -- <ROUTER_IP>
#
# Examples:
#   sudo bash configure-ollama-host.sh 192.168.1.20
#   curl -fsSL ... | sudo ROUTER_IP=192.168.1.20 bash
#
# What it does:
#   1) Binds Ollama to 0.0.0.0:11434 (reachable on LAN)
#   2) Restarts Ollama
#   3) Opens UFW 11434 only from the router IP (if UFW is available)
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root (use the curl | sudo bash one-liner)."
  exit 1
fi

ROUTER_IP="${1:-${ROUTER_IP:-}}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"

if [[ -z "$ROUTER_IP" ]]; then
  echo "Usage: $0 <ROUTER_IP>"
  echo "   or: ROUTER_IP=x.x.x.x $0"
  echo ""
  echo "ROUTER_IP = the Ubuntu VM running LLMrouterVEX (not this Ollama host)."
  exit 1
fi

# Basic IPv4 sanity (also allow hostnames)
if ! [[ "$ROUTER_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$ROUTER_IP" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid ROUTER_IP: $ROUTER_IP"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if ! command -v ollama >/dev/null 2>&1 && ! systemctl list-unit-files | grep -q '^ollama.service'; then
  echo "Warning: ollama service not found. Install Ollama first: https://ollama.com/download"
fi

echo "==> Binding Ollama to 0.0.0.0:${OLLAMA_PORT}"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT}"
EOF

systemctl daemon-reload
if systemctl list-unit-files | grep -q '^ollama.service'; then
  systemctl restart ollama.service
  systemctl is-active --quiet ollama.service && echo "   ollama.service is active"
else
  echo "   (ollama.service not installed as systemd unit — set OLLAMA_HOST manually if needed)"
fi

echo "==> Firewall: allow ${OLLAMA_PORT}/tcp from router ${ROUTER_IP} only"
if command -v ufw >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y ufw >/dev/null 2>&1 || true

  # Keep SSH
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp comment 'OpenSSH' >/dev/null 2>&1 || true

  # Remove overly broad Ollama rules if present, then add router-only rule
  ufw delete allow "${OLLAMA_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow from "$ROUTER_IP" to any port "$OLLAMA_PORT" proto tcp comment 'LLMrouterVEX' >/dev/null 2>&1 \
    || ufw allow from "$ROUTER_IP" to any port "$OLLAMA_PORT" proto tcp

  ufw default deny incoming >/dev/null 2>&1 || true
  ufw default allow outgoing >/dev/null 2>&1 || true

  if ! ufw status | grep -qi "Status: active"; then
    ufw --force enable
  else
    ufw reload >/dev/null 2>&1 || true
  fi

  echo "==> UFW status"
  ufw status numbered || true
else
  echo "   ufw not installed — opening port with iptables hint skipped."
  echo "   Install ufw or allow ${OLLAMA_PORT}/tcp from ${ROUTER_IP} manually."
fi

# Quick local listen check
if command -v ss >/dev/null 2>&1; then
  if ss -lnt | grep -qE ":${OLLAMA_PORT}\\s"; then
    echo "==> Port ${OLLAMA_PORT} is listening"
  else
    echo "==> Warning: nothing listening on :${OLLAMA_PORT} yet (is Ollama installed/running?)"
  fi
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================================"
echo " Ollama host ready for LLMrouterVEX"
echo " This host:     ${HOST_IP:-<this-ip>}:${OLLAMA_PORT}"
echo " Allowed from:  ${ROUTER_IP} (router VM only)"
echo " Add in UI:     http://${ROUTER_IP}:8080/servers"
echo "                host = ${HOST_IP:-<this-ip>}"
echo " Test from router VM:"
echo "   curl http://${HOST_IP:-<this-ip>}:${OLLAMA_PORT}/api/tags"
echo "============================================================"
echo ""
