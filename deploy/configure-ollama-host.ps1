#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Configure Windows Ollama so LLMrouterVEX (LAN or Tailscale) can reach it.

  - Sets OLLAMA_HOST=0.0.0.0:11434 (Machine + User env)
  - Restarts Ollama processes
  - Windows Firewall: allow TCP 11434 from router IP (and tailnet if 100.x)
  - Optional: join Tailscale if -TsAuthKey / $env:TS_AUTHKEY is set

.EXAMPLE
  # One-liner (Admin PowerShell) — router Tailscale IP:
  $env:ROUTER_IP='100.64.0.12'; `
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex

.EXAMPLE
  # Join Tailscale + configure Ollama in one go:
  $env:ROUTER_IP='100.64.0.12'; $env:TS_AUTHKEY='tskey-auth-XXXX'; $env:TS_HOSTNAME='gpu-pc'; `
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex

.EXAMPLE
  .\configure-ollama-host.ps1 -RouterIp 100.64.0.12
#>
param(
  [Parameter(Mandatory = $false)]
  [string]$RouterIp = $env:ROUTER_IP,

  [int]$OllamaPort = $(if ($env:OLLAMA_PORT) { [int]$env:OLLAMA_PORT } else { 11434 }),

  [string]$TsAuthKey = $env:TS_AUTHKEY,
  [string]$TsHostname = $env:TS_HOSTNAME,

  # If true, also allow entire Tailscale CGNAT range (100.64.0.0/10)
  [switch]$AllowEntireTailnet = ($env:ALLOW_TAILNET -eq "1")
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

if (-not $RouterIp) {
  Write-Host @"
Missing ROUTER_IP / -RouterIp.

This must be the LLMrouterVEX host (LAN IP or Tailscale 100.x IP).

Admin PowerShell one-liner:
  `$env:ROUTER_IP='100.64.0.12'; ``
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex

With Tailscale join:
  `$env:ROUTER_IP='100.64.0.12'; `$env:TS_AUTHKEY='tskey-auth-XXXX'; ``
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex
"@ -ForegroundColor Yellow
  exit 1
}

# Optional Tailscale join first
if ($TsAuthKey) {
  Write-Step "TS_AUTHKEY set — installing/joining Tailscale first"
  $tsScriptUrl = "https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.ps1"
  $env:TS_AUTHKEY = $TsAuthKey
  if ($TsHostname) { $env:TS_HOSTNAME = $TsHostname }
  try {
    Invoke-Expression (Invoke-WebRequest -Uri $tsScriptUrl -UseBasicParsing).Content
  } catch {
    Write-Warn "Tailscale install script failed: $($_.Exception.Message)"
    Write-Warn "Install Tailscale manually, then re-run this script without TS_AUTHKEY."
  }
}

function Test-IsTailscaleIp([string]$ip) {
  if ($ip -notmatch '^100\.(\d+)\.') { return $false }
  $n = [int]$Matches[1]
  return ($n -ge 64 -and $n -le 127)
}

function Get-TailscaleExe {
  foreach ($p in @(
      "$env:ProgramFiles\Tailscale\tailscale.exe",
      "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
    )) {
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ── OLLAMA_HOST ─────────────────────────────────────────────────────
Write-Step "Setting OLLAMA_HOST=0.0.0.0:$OllamaPort (Machine + User)"
$ollamaHost = "0.0.0.0:$OllamaPort"
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $ollamaHost, "Machine")
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", $ollamaHost, "User")
$env:OLLAMA_HOST = $ollamaHost

# ── Restart Ollama ──────────────────────────────────────────────────
Write-Step "Restarting Ollama"
$ollamaProcs = Get-Process -Name "ollama*" -ErrorAction SilentlyContinue
if ($ollamaProcs) {
  $ollamaProcs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# Prefer Start Menu / default install paths
$ollamaExe = @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "$env:ProgramFiles\Ollama\ollama.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($ollamaExe) {
  # "ollama serve" in background if app not already re-launched by tray
  Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
  Write-Host "    Started: $ollamaExe serve"
} else {
  Write-Warn "ollama.exe not found. Start Ollama from the tray/app manually so it picks up OLLAMA_HOST."
}

# Also try to relaunch the app if present
$ollamaApp = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
if (Test-Path $ollamaApp) {
  Start-Process -FilePath $ollamaApp -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# ── Windows Firewall ────────────────────────────────────────────────
Write-Step "Configuring Windows Firewall for TCP $OllamaPort from $RouterIp"

$ruleName = "LLMrouterVEX Ollama from router"
$ruleNameTailnet = "LLMrouterVEX Ollama Tailscale CGNAT"

# Remove previous versions of our rules
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName $ruleNameTailnet -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "LLMrouterVEX Ollama" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $OllamaPort `
  -RemoteAddress $RouterIp `
  -Profile Any `
  -Description "Allow LLMrouterVEX host to reach Ollama" | Out-Null

$isTs = Test-IsTailscaleIp $RouterIp
if ($isTs -or $AllowEntireTailnet) {
  New-NetFirewallRule `
    -DisplayName $ruleNameTailnet `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $OllamaPort `
    -RemoteAddress "100.64.0.0/10" `
    -Profile Any `
    -Description "Allow Tailscale mesh to reach Ollama" | Out-Null
  Write-Host "    Also allowed Tailscale CGNAT 100.64.0.0/10"
}

Write-Host "    Rule: allow TCP $OllamaPort from $RouterIp"

# ── Listen check ────────────────────────────────────────────────────
Write-Step "Checking listeners on port $OllamaPort"
$listening = Get-NetTCPConnection -LocalPort $OllamaPort -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $listening | Select-Object -First 3 LocalAddress, LocalPort, State | Format-Table | Out-String | Write-Host
} else {
  Write-Warn "Nothing listening on :$OllamaPort yet."
  Write-Warn "Fully quit Ollama from the system tray and open it again so OLLAMA_HOST is applied."
}

# Local self-test
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$OllamaPort/api/version" -TimeoutSec 3
  Write-Host "    Local Ollama OK — version $($r.version)"
} catch {
  Write-Warn "Local http://127.0.0.1:$OllamaPort/api/version failed — is Ollama running?"
}

$ts = Get-TailscaleExe
$tsIp = $null
if ($ts) {
  try { $tsIp = (& $ts ip -4 2>$null | Select-Object -First 1) } catch { }
}

Write-Host ""
Write-Host "============================================================"
Write-Host " Windows Ollama host ready for LLMrouterVEX"
Write-Host " Router allowed:  $RouterIp"
Write-Host " OLLAMA_HOST:     $ollamaHost"
Write-Host " This Tailscale:  $(if ($tsIp) { $tsIp } else { 'not joined / unknown' })"
Write-Host ""
Write-Host " On the router dashboard → Servers, add:"
Write-Host "   $(if ($tsIp) { $tsIp } else { '<this-machine-tailscale-or-lan-ip>' })"
Write-Host ""
Write-Host " Test FROM the router VM:"
Write-Host "   curl http://$(if ($tsIp) { $tsIp } else { '<this-ip>' }):$OllamaPort/api/tags"
Write-Host "============================================================"
Write-Host ""
