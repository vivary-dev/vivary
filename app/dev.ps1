# Dev launcher for the Vivary GUI: starts the FastAPI backend and the Vite frontend with
# one shared auth token, then stops the backend when you Ctrl-C the frontend.
#
#   pwsh app/dev.ps1        (or right-click > Run, or  ./dev.ps1  from app/)
#
# The token is reused from the last launch (~/.vivary-gui/runtime.json) so browser
# refreshes keep working; it is mirrored into frontend/.env.local for the SPA.
$ErrorActionPreference = 'Stop'
$root     = $PSScriptRoot
$backend  = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$py       = Join-Path $backend '.venv/Scripts/python.exe'

if (-not (Test-Path $py)) {
  throw "backend venv not found at $py — create it first (python -m venv .venv; pip install -e backend)"
}

# 1. Pick a stable token: reuse the last launch's, else mint one.
$runtime = Join-Path $env:USERPROFILE '.vivary-gui/runtime.json'
$token = $null
if (Test-Path $runtime) {
  try { $token = (Get-Content $runtime -Raw | ConvertFrom-Json).token } catch { $token = $null }
}
if (-not $token) { $token = & $py -c "import secrets;print(secrets.token_urlsafe(32))" }

$env:VIVARY_GUI_TOKEN = $token   # backend honors this
$env:VITE_VIVARY_TOKEN = $token  # vite injects this into the SPA
Set-Content -Path (Join-Path $frontend '.env.local') -Value "VITE_VIVARY_TOKEN=$token" -Encoding utf8

# 2. Start the backend in the background.
$job = Start-Job -ScriptBlock {
  param($py, $backend, $token)
  $env:VIVARY_GUI_TOKEN = $token
  & $py -m uvicorn vivary_gui.main:app --app-dir $backend --host 127.0.0.1 --port 8765
} -ArgumentList $py, $backend, $token

try {
  # 3. Wait for the backend to answer health.
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-RestMethod 'http://127.0.0.1:8765/api/health' -TimeoutSec 1 | Out-Null; $ready = $true; break }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ready) {
    Write-Host '[vivary-gui] backend did not become healthy on :8765 — its output:' -ForegroundColor Red
    Receive-Job $job
    throw 'backend failed to start'
  }
  Write-Host '[vivary-gui] backend ready  -> http://127.0.0.1:8765' -ForegroundColor Green
  Write-Host '[vivary-gui] starting frontend -> http://localhost:5173  (Ctrl-C to stop both)' -ForegroundColor Green

  # 4. Run the frontend in the foreground; Ctrl-C here drops into finally.
  Push-Location $frontend
  npm run dev
}
finally {
  Pop-Location -ErrorAction SilentlyContinue
  Write-Host '[vivary-gui] stopping backend ...' -ForegroundColor Yellow
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
}
