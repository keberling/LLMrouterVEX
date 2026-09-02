<#
.SYNOPSIS
  Install local OpenAI-compatible Whisper STT for LLMrouterVEX (Windows LLM/GPU box).

  Always writes C:\llmrouter-whisper\install.log and does not use `exit`
  (exit kills the PowerShell window when this is run via irm | iex).
#>

$ErrorActionPreference = "Continue"
$RouterIp = $env:ROUTER_IP
$Port = if ($env:PORT) { [int]$env:PORT } else { 8090 }
$Model = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "base" }
$Device = if ($env:WHISPER_DEVICE) { $env:WHISPER_DEVICE } else { "cpu" }
$AppDir = "C:\llmrouter-whisper"
$LogFile = "C:\llmrouter-whisper\install.log"
$ServerPyUrl = "https://raw.githubusercontent.com/keberling/LLMrouterVEX/main/deploy/whisper-openai-server.py"

function Wait-Done([string]$msg) {
  Write-Host ""
  Write-Host $msg -ForegroundColor Yellow
  Write-Host "Log: $LogFile" -ForegroundColor Yellow
  try { [void](Read-Host "Press Enter to finish") } catch { Start-Sleep -Seconds 15 }
}

function Write-Step($msg) {
  $line = "==> $msg"
  Write-Host $line -ForegroundColor Cyan
  Add-Content -Path $LogFile -Value $line
}
function Write-Warn($msg) {
  $line = "    $msg"
  Write-Host $line -ForegroundColor Yellow
  Add-Content -Path $LogFile -Value $line
}

try {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  Start-Transcript -Path $LogFile -Force | Out-Null
} catch { }

$isAdmin = $false
try {
  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
} catch { }
if (-not $isAdmin) {
  Write-Host "This must run in Admin PowerShell (right-click -> Run as administrator)." -ForegroundColor Red
  Wait-Done "Not admin. Window staying open."
  return
}

if (-not $RouterIp) {
  Write-Host "Set `$env:ROUTER_IP='100.69.34.12' then re-run." -ForegroundColor Yellow
  Wait-Done "ROUTER_IP missing."
  return
}

try {
Write-Step "Installing Whisper STT for router $RouterIp on port $Port"

Write-Step "Downloading server.py"
$serverPath = Join-Path $AppDir "server.py"
Invoke-WebRequest -Uri $ServerPyUrl -OutFile $serverPath -UseBasicParsing

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Test-RealPython([string]$exe) {
  if (-not $exe) { return $false }
  if ($exe -match '\\WindowsApps\\') { return $false }
  if ($exe -match 'pythoncore-3\.14') { return $false }
  if (-not (Test-Path -LiteralPath $exe)) { return $false }
  try {
    $code = "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)"
    & $exe -c $code 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Resolve-PythonFromPyLauncher([string]$pyExe) {
  foreach ($flag in @("-3.12", "-3.11", "-3.13", "-3")) {
    try {
      $out = & $pyExe $flag -c "import sys; print(sys.executable)" 2>$null
      $resolved = if ($out) { ($out | Select-Object -Last 1).Trim() } else { $null }
      if ($resolved -and (Test-RealPython $resolved)) { return $resolved }
    } catch { }
  }
  return $null
}

function Find-Python {
  Refresh-Path
  $cmds = @(
    "$env:ProgramFiles\Python312\python.exe",
    "$env:LocalAppData\Programs\Python\Python312\python.exe",
    "$env:LocalAppData\Python\pythoncore-3.12-64\python.exe",
    "${env:ProgramFiles(x86)}\Python312\python.exe",
    "$env:LocalAppData\Programs\Python\Python311\python.exe",
    "$env:ProgramFiles\Python311\python.exe",
    "$env:LocalAppData\Programs\Python\Python313\python.exe",
    "$env:ProgramFiles\Python313\python.exe"
  )
  foreach ($name in @("py", "python", "python3")) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Source) { $cmds += $c.Source }
  }
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

$pythonExe = Find-Python
if (-not $pythonExe) {
  Write-Step "Installing Python 3.12 via winget"
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements
  Refresh-Path
  $pythonExe = Find-Python
}
if ($pythonExe -match '3\.14' -or -not $pythonExe) {
  Write-Warn "Need Python 3.12 (not 3.14). Installing 3.12…"
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements
  Refresh-Path
  $pythonExe = Find-Python
}
if (-not $pythonExe) {
  Wait-Done "No Python 3.12 found. Install from python.org with Add to PATH, then re-run."
  return
}

Write-Step "Using Python $pythonExe"
try {
  winget install -e --id Microsoft.VCRedist.2015+.x64 --accept-package-agreements --accept-source-agreements
} catch { Write-Warn "VC++ redist winget skipped: $_" }

function Stop-Whisper {
  Write-Step "Stopping existing Whisper"
  Stop-ScheduledTask -TaskName "LLMrouterVEX-Whisper-STT" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "LLMrouterVEX-Whisper-STT" -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.ExecutablePath -and $_.ExecutablePath -like "*llmrouter-whisper*") -or
      ($_.CommandLine -and $_.CommandLine -like "*llmrouter-whisper*")
    } |
    ForEach-Object { cmd /c "taskkill /F /PID $($_.ProcessId) /T" | Out-Null }
  Start-Sleep -Seconds 2
}

$venvDir = Join-Path $AppDir "venv312"
$venvPy = Join-Path $venvDir "Scripts\python.exe"
Stop-Whisper
Write-Step "Python venv + faster-whisper"
if (-not (Test-Path -LiteralPath $venvPy)) {
  & $pythonExe -m venv $venvDir
}
if (-not (Test-Path -LiteralPath $venvPy)) {
  Wait-Done "venv python missing at $venvPy"
  return
}
& $venvPy -m pip install --upgrade pip wheel
& $venvPy -m pip install faster-whisper fastapi uvicorn python-multipart intel-openmp
Write-Step "Verifying ctranslate2"
$probe = @"
import os, sys
from pathlib import Path
pkg = Path(sys.prefix) / 'Lib' / 'site-packages' / 'ctranslate2'
if pkg.is_dir():
    os.add_dll_directory(str(pkg))
    os.environ['PATH'] = str(pkg) + os.pathsep + os.environ.get('PATH', '')
import ctranslate2
print('ctranslate2', ctranslate2.__version__)
"@
& $venvPy -c $probe
if ($LASTEXITCODE -ne 0) {
  Write-Warn "ctranslate2 import failed. Whisper may still start after a reboot (VC++)."
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  try { winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements } catch { }
}

Write-Step "Firewall TCP $Port from $RouterIp"
Get-NetFirewallRule -DisplayName "LLMrouterVEX STT $Port" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "LLMrouterVEX STT $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress $RouterIp -Action Allow -ErrorAction SilentlyContinue | Out-Null
if ($RouterIp -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.') {
  New-NetFirewallRule -DisplayName "LLMrouterVEX STT tailnet $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress "100.64.0.0/10" -Action Allow -ErrorAction SilentlyContinue | Out-Null
}

$startCmd = Join-Path $AppDir "start.cmd"
@"
@echo off
cd /d $AppDir
set HOST=0.0.0.0
set PORT=$Port
set WHISPER_MODEL=$Model
set WHISPER_DEVICE=$Device
set CUDA_VISIBLE_DEVICES=-1
"$venvPy" -u "$serverPath" >> "$AppDir\whisper.log" 2>&1
"@ | Set-Content -Path $startCmd -Encoding ASCII

Write-Step "Register boot task + start Whisper now"
$taskName = "LLMrouterVEX-Whisper-STT"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$startCmd`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

$env:HOST = "0.0.0.0"
$env:PORT = "$Port"
$env:WHISPER_MODEL = $Model
$env:WHISPER_DEVICE = $Device
$env:CUDA_VISIBLE_DEVICES = "-1"
Start-Process -FilePath $venvPy -ArgumentList @("-u", $serverPath) -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput "$AppDir\whisper.out.log" -RedirectStandardError "$AppDir\whisper.err.log"
Start-Sleep -Seconds 4

Write-Step "Local health check"
try {
  $h = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5
  Write-Step "Health $($h.StatusCode) $($h.Content)"
} catch {
  Write-Warn "Health check failed: $_. See $AppDir\whisper.err.log"
  if (Test-Path "$AppDir\whisper.err.log") { Get-Content "$AppDir\whisper.err.log" -ErrorAction SilentlyContinue | ForEach-Object { Write-Warn $_ } }
}

$tsIp = $null
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  try { $tsIp = (& tailscale ip -4 2>$null | Select-Object -First 1) } catch { }
}
$addHost = if ($tsIp) { $tsIp } else {
  (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } |
    Select-Object -First 1).IPAddress
}

Write-Host ""
Write-Host "============================================================"
Write-Host " Whisper STT"
Write-Host " Python:        $pythonExe"
Write-Host " This host:     $addHost"
Write-Host " Listen:        0.0.0.0:$Port"
Write-Host " Model:         $Model ($Device)"
Write-Host " Allowed from:  $RouterIp"
Write-Host " Log:           $LogFile"
Write-Host " Whisper log:   $AppDir\whisper.err.log"
Write-Host ""
Write-Host " Router UI -> Servers -> Kind Whisper STT -> ${addHost}:$Port"
Write-Host "============================================================"

} catch {
  Write-Host "ERROR: $_" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
  try { Stop-Transcript | Out-Null } catch { }
  try { notepad.exe $LogFile } catch { }
  Wait-Done "Install hit an error. Notepad should show the log."
  return
}

try { Stop-Transcript | Out-Null } catch { }
try { notepad.exe $LogFile } catch { }
Wait-Done "Done. Notepad opened install.log. Press Enter."
