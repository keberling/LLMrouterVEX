# Install local OpenAI-compatible Whisper STT for LLMrouterVEX (Windows GPU box).
#
# Admin PowerShell:
#   $env:ROUTER_IP='100.64.0.12'
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\deploy\install-whisper.ps1
#
# Then add this host on the router UI as Kind: Whisper STT, port 8090.

$ErrorActionPreference = "Stop"
$Port = if ($env:PORT) { $env:PORT } else { "8090" }
$Model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "base" }
$Device = if ($env:WHISPER_DEVICE) { $env:WHISPER_DEVICE } else { "auto" }
$AppDir = "C:\llmrouter-whisper"
$RouterIp = $env:ROUTER_IP

if (-not $RouterIp) {
    Write-Host "Set ROUTER_IP to the LLMrouterVEX LAN or Tailscale IP, then re-run."
    exit 1
}

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$here\whisper-openai-server.py" "$AppDir\server.py" -Force

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "Python 3 is required. Install from https://www.python.org/downloads/"
    exit 1
}

python -m venv "$AppDir\venv"
& "$AppDir\venv\Scripts\python.exe" -m pip install --upgrade pip
& "$AppDir\venv\Scripts\pip.exe" install faster-whisper fastapi uvicorn python-multipart

# Firewall: 8090 only from router
$rule = "LLMrouterVEX STT 8090"
if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $rule
}
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress $RouterIp -Action Allow | Out-Null

$venvPython = "$AppDir\venv\Scripts\python.exe"
Write-Host "Starting Whisper on 0.0.0.0:$Port (model=$Model). Leave this window open, or register a Windows service."
$env:HOST = "0.0.0.0"
$env:PORT = "$Port"
$env:WHISPER_MODEL = $Model
$env:WHISPER_DEVICE = $Device
& $venvPython "$AppDir\server.py"
