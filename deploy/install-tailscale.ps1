#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install Tailscale on Windows and join your tailnet.

.EXAMPLE
  # One-liner (Admin PowerShell):
  $env:TS_AUTHKEY='tskey-auth-XXXX'; $env:TS_HOSTNAME='gpu-box'; `
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.ps1 | iex

.EXAMPLE
  .\install-tailscale.ps1 -AuthKey tskey-auth-XXXX -Hostname gpu-box
#>
param(
  [string]$AuthKey = $env:TS_AUTHKEY,
  [string]$Hostname = $env:TS_HOSTNAME,
  [switch]$AcceptRoutes = ($env:TS_ACCEPT_ROUTES -eq "1")
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if (-not $AuthKey) {
  Write-Host @"
Missing TS_AUTHKEY / -AuthKey.

Create a key: https://login.tailscale.com/admin/settings/keys

One-liner (Admin PowerShell):
  `$env:TS_AUTHKEY='tskey-auth-XXXX'; `$env:TS_HOSTNAME='gpu-box'; ``
    irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-tailscale.ps1 | iex
"@ -ForegroundColor Yellow
  exit 1
}

function Get-TailscaleExe {
  $candidates = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
    "$env:LOCALAPPDATA\Tailscale\tailscale.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

Write-Step "Installing Tailscale (if needed)"
$ts = Get-TailscaleExe
if (-not $ts) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    winget install -e --id Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
  } else {
    Write-Step "winget not found — downloading Tailscale installer"
    $msi = Join-Path $env:TEMP "tailscale-setup.exe"
    # Official Windows installer redirect
    Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.exe" `
      -OutFile $msi -UseBasicParsing
    Start-Process -FilePath $msi -ArgumentList "/quiet" -Wait
  }
  # Wait for CLI to appear
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $ts = Get-TailscaleExe
    if ($ts) { break }
  }
}

if (-not $ts) {
  throw "Tailscale installed but CLI not found. Open Tailscale once from the Start menu, then re-run."
}

Write-Step "Using CLI: $ts"

$upArgs = @("up", "--authkey=$AuthKey", "--accept-dns=true", "--unattended")
if ($Hostname) { $upArgs += "--hostname=$Hostname" }
if ($AcceptRoutes) { $upArgs += "--accept-routes" }

Write-Step "Bringing Tailscale up"
& $ts @upArgs

Start-Sleep -Seconds 2
Write-Step "Status"
& $ts status

$ip = & $ts ip -4 2>$null
Write-Host ""
Write-Host "============================================================"
Write-Host " Tailscale joined (Windows)"
Write-Host " Tailscale IPv4: $ip"
Write-Host "============================================================"
Write-Host ""
Write-Host "Next — configure Ollama for the router (Admin PowerShell):"
Write-Host "  `$env:ROUTER_IP='<router-tailscale-ip>'; irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/configure-ollama-host.ps1 | iex"
Write-Host ""
