#!/usr/bin/env bash
# Install & join Tailscale on the LLMrouterVEX host (or any Ubuntu box).
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \
#     | sudo TS_AUTHKEY=tskey-auth-XXXX bash
#
# Optional:
#   TS_HOSTNAME=llm-router
#   TS_SSH=1                 # enable Tailscale SSH
#   TS_ACCEPT_ROUTES=1
#   TS_ADVERTISE_TAGS=tag:llmrouter
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: curl ... | sudo TS_AUTHKEY=... bash"
  exit 1
fi

TS_AUTHKEY="${TS_AUTHKEY:-${1:-}}"
TS_HOSTNAME="${TS_HOSTNAME:-}"
TS_SSH="${TS_SSH:-0}"
TS_ACCEPT_ROUTES="${TS_ACCEPT_ROUTES:-0}"
TS_ADVERTISE_TAGS="${TS_ADVERTISE_TAGS:-}"

if [[ -z "$TS_AUTHKEY" ]]; then
  echo "Missing TS_AUTHKEY."
  echo "Create a reusable/ephemeral auth key: https://login.tailscale.com/admin/settings/keys"
  echo ""
  echo "Example:"
  echo "  curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.sh \\"
  echo "    | sudo TS_AUTHKEY=tskey-auth-XXXX TS_HOSTNAME=llm-router bash"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "   tailscale already installed: $(tailscale version | head -n1)"
fi

UP_ARGS=(--authkey="$TS_AUTHKEY" --accept-dns=true)
if [[ -n "$TS_HOSTNAME" ]]; then
  UP_ARGS+=(--hostname="$TS_HOSTNAME")
fi
if [[ "$TS_SSH" == "1" || "$TS_SSH" == "true" ]]; then
  UP_ARGS+=(--ssh)
fi
if [[ "$TS_ACCEPT_ROUTES" == "1" || "$TS_ACCEPT_ROUTES" == "true" ]]; then
  UP_ARGS+=(--accept-routes)
fi
if [[ -n "$TS_ADVERTISE_TAGS" ]]; then
  UP_ARGS+=(--advertise-tags="$TS_ADVERTISE_TAGS")
fi

echo "==> Bringing Tailscale up"
tailscale up "${UP_ARGS[@]}"

# Prefer allowing router UI on the tailnet interface when UFW is active
if command -v ufw >/dev/null 2>&1 && ufw status | grep -qi "Status: active"; then
  echo "==> Allowing LLMrouter port 8080 on tailscale0 (if present)"
  ufw allow in on tailscale0 to any port 8080 proto tcp comment 'LLMrouterVEX Tailscale' >/dev/null 2>&1 || true
  # Tailscale CGNAT range (optional belt-and-suspenders)
  ufw allow from 100.64.0.0/10 to any port 8080 proto tcp comment 'LLMrouterVEX tailnet' >/dev/null 2>&1 || true
  ufw reload >/dev/null 2>&1 || true
fi

sleep 1
echo "==> Tailscale status"
tailscale status || true
IP="$(tailscale ip -4 2>/dev/null || true)"
DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":"\([^"]*\)".*/\1/p' | head -n1 | sed 's/\.$//')"

echo ""
echo "============================================================"
echo " Tailscale joined"
echo " Tailscale IPv4: ${IP:-unknown}"
echo " MagicDNS:       ${DNS:-unknown}"
echo " Dashboard:      http://${IP:-<tailscale-ip>}:8080/"
echo "============================================================"
echo ""
echo "On each Ollama host (also on Tailscale), either:"
echo "  1) Install Tailscale with the same tailnet auth key, then:"
echo "     curl -fsSL https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.sh \\"
echo "       | sudo bash -s -- ${IP:-<router-tailscale-ip>}"
echo "  2) Or add the peer from the router UI (Servers → Tailscale peers)"
echo ""
