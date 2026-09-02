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

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Test-RealPython([string]$exe) {
  if (-not $exe) { return $false }
  if ($exe -match '\\WindowsApps\\') { return $false }
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  try {
    $code = @"
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
"@
    & $exe -c $code 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Resolve-PythonFromPyLauncher([string]$pyExe) {
  try {
    $out = & $pyExe -3 -c "import sys; print(sys.executable)" 2>$null
    $resolved = if ($out) { ($out | Select-Object -Last 1).Trim() } else { $null }
    if ($resolved -and (Test-RealPython $resolved)) { return $resolved }
  } catch { }
  return $null
}

function Find-Python {
  Refresh-Path
  $cmds = @()
  foreach ($name in @("py", "python", "python3")) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { $cmds += $c.Source }
  }
  $cmds += @(
    "$env:LocalAppData\Programs\Python\Python313\python.exe",
    "$env:LocalAppData\Programs\Python\Python312\python.exe",
    "$env:LocalAppData\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python313\python.exe",
    "$env:ProgramFiles\Python312\python.exe",
    "${env:ProgramFiles(x86)}\Python313\python.exe"
  )
  foreach ($exe in $cmds) {
    if ($exe -match '\\WindowsApps\\') { continue }
    if ($exe -match '\\py\.exe$') {
      $resolved = Resolve-PythonFromPyLauncher $exe
      if ($resolved) { return $resolved }
      continue
    }
    if (Test-RealPython $exe) { return $exe }
  }
  return $null
}

function Install-Python {
  Write-Step "No real Python found (Windows Store stub does not count). Installing Python 3.12…"
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

$pythonExe = Find-Python
if (-not $pythonExe) {
  try { Install-Python } catch {
    Write-Host "winget could not install Python. Install from https://www.python.org/downloads/ — check 'Add python.exe to PATH' — then re-run." -ForegroundColor Red
    exit 1
  }
  $pythonExe = Find-Python
}
if (-not $pythonExe) {
  Write-Host @"
Still no real Python on PATH.

1) Settings → Apps → Advanced app settings → App execution aliases
   Turn OFF python.exe and python3.exe
2) Install https://www.python.org/downloads/ with 'Add python.exe to PATH'
3) Close this window, open a NEW Admin PowerShell, re-run the installer.
"@ -ForegroundColor Red
  exit 1
}

Write-Step "Python venv + faster-whisper ($pythonExe)"
$venvDir = Join-Path $AppDir "venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"
if (Test-Path $venvDir) { Remove-Item $venvDir -Recurse -Force }
& $pythonExe -m venv $venvDir
if (-not (Test-Path -LiteralPath $venvPy)) {
  Write-Host "venv was not created at $venvPy. Python is still the Store stub. Install python.org Python and disable App execution aliases." -ForegroundColor Red
  exit 1
}
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
