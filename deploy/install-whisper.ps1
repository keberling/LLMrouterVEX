#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install local OpenAI-compatible Whisper STT for LLMrouterVEX (Windows LLM/GPU box).

.EXAMPLE
  # Admin PowerShell one-liner:
  $env:ROUTER_IP='100.69.34.12'
  irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-whisper.ps1 | iex
#>
param(
  [string]$RouterIp = $env:ROUTER_IP,
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8090 }),
  [string]$Model = $(if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "base" }),
  [string]$Device = $(if ($env:WHISPER_DEVICE) { $env:WHISPER_DEVICE } else { "cpu" })
)

$ErrorActionPreference = "Stop"
$AppDir = "C:\llmrouter-whisper"
$ServerPyUrl = "https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/whisper-openai-server.py"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

if (-not $RouterIp) {
  Write-Host @"
Missing ROUTER_IP.

Admin PowerShell:
  `$env:ROUTER_IP='100.69.34.12'
  irm https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/install-whisper.ps1 | iex
"@ -ForegroundColor Yellow
  exit 1
}

Write-Step "Installing Whisper STT for router $RouterIp on port $Port"

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

Write-Step "Downloading server.py"
$serverPath = Join-Path $AppDir "server.py"
$localScript = $null
if ($PSScriptRoot) { $localScript = Join-Path $PSScriptRoot "whisper-openai-server.py" }
if ($localScript -and (Test-Path $localScript)) {
  Copy-Item $localScript $serverPath -Force
} else {
  Invoke-WebRequest -Uri $ServerPyUrl -OutFile $serverPath -UseBasicParsing
}

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Host "Python 3 is required. Install from https://www.python.org/downloads/ (check 'Add python.exe to PATH'), then re-run." -ForegroundColor Red
  exit 1
}

Write-Step "Python venv + faster-whisper ($($py.Source))"
$venvPy = Join-Path $AppDir "venv\Scripts\python.exe"
& $py.Source -m venv (Join-Path $AppDir "venv")
& $venvPy -m pip install --upgrade pip wheel
& $venvPy -m pip install faster-whisper fastapi uvicorn python-multipart

Write-Step "ffmpeg (required to decode iPhone m4a)"
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
  try {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
  } catch {
    Write-Warn "Could not install ffmpeg via winget. Install ffmpeg and add it to PATH if transcription of .m4a fails."
  }
}

Write-Step "Firewall: TCP $Port from $RouterIp (+ tailnet)"
$rule = "LLMrouterVEX STT $Port"
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port `
  -RemoteAddress $RouterIp -Action Allow | Out-Null
if ($RouterIp -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.') {
  New-NetFirewallRule -DisplayName "LLMrouterVEX STT tailnet $Port" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress "100.64.0.0/10" -Action Allow -ErrorAction SilentlyContinue | Out-Null
}

$startCmd = Join-Path $AppDir "start.cmd"
@"
@echo off
set HOST=0.0.0.0
set PORT=$Port
set WHISPER_MODEL=$Model
set WHISPER_DEVICE=$Device
"$venvPy" "$serverPath"
"@ | Set-Content -Path $startCmd -Encoding ASCII

Write-Step "Scheduled task (start at boot)"
$taskName = "LLMrouterVEX-Whisper-STT"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $startCmd -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 3
$tsIp = $null
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if ($ts) {
  try { $tsIp = (& tailscale ip -4 2>$null | Select-Object -First 1) } catch { }
}
$addHost = if ($tsIp) { $tsIp } else { (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } | Select-Object -First 1).IPAddress }

Write-Host ""
Write-Host "============================================================"
Write-Host " Whisper STT ready for LLMrouterVEX"
Write-Host " This host:     $addHost"
Write-Host " Listen:        0.0.0.0:$Port"
Write-Host " Model:         $Model ($Device)"
Write-Host " Allowed from:  $RouterIp"
Write-Host ""
Write-Host " On the router UI -> Servers:"
Write-Host "   Kind: Whisper STT"
Write-Host "   Host: ${addHost}:$Port"
Write-Host ""
Write-Host " Test from this box:"
Write-Host "   curl http://127.0.0.1:$Port/health"
Write-Host " Test from router:"
Write-Host "   curl http://${addHost}:$Port/health"
Write-Host "============================================================"
