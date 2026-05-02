# Poly-BTC-Bot — auto-restart launcher
# Keeps both backend (port 3001) and frontend (port 5173) running indefinitely.
# Run: powershell -ExecutionPolicy Bypass -File start.ps1

$root   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$server = "$root\server"
$delay  = 3   # seconds before restart attempt

function Kill-Port($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
    }
}

function Start-Backend {
    Write-Host "[LAUNCHER] Starting backend on :3001..." -ForegroundColor Cyan
    Kill-Port 3001
    return Start-Process -FilePath "node" -ArgumentList "index.js" `
        -WorkingDirectory $server -PassThru -NoNewWindow
}

function Start-Frontend {
    Write-Host "[LAUNCHER] Starting frontend on :5173..." -ForegroundColor Cyan
    Kill-Port 5173
    Kill-Port 5174
    return Start-Process -FilePath "npm" -ArgumentList "run","dev","--","--port","5173" `
        -WorkingDirectory $root -PassThru -NoNewWindow
}

$be = Start-Backend
$fe = Start-Frontend

Write-Host ""
Write-Host "  Bot:  http://localhost:5173" -ForegroundColor Green
Write-Host "  API:  http://localhost:3001" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop all" -ForegroundColor Yellow
Write-Host ""

try {
    while ($true) {
        Start-Sleep -Seconds 5

        if ($be.HasExited) {
            Write-Host "[LAUNCHER] Backend crashed (exit $($be.ExitCode)) — restarting in ${delay}s..." -ForegroundColor Red
            Start-Sleep -Seconds $delay
            $be = Start-Backend
        }

        if ($fe.HasExited) {
            Write-Host "[LAUNCHER] Frontend crashed (exit $($fe.ExitCode)) — restarting in ${delay}s..." -ForegroundColor Red
            Start-Sleep -Seconds $delay
            $fe = Start-Frontend
        }
    }
} finally {
    Write-Host "[LAUNCHER] Stopping..." -ForegroundColor Yellow
    if (-not $be.HasExited) { Stop-Process -Id $be.Id -Force -ErrorAction SilentlyContinue }
    if (-not $fe.HasExited) { Stop-Process -Id $fe.Id -Force -ErrorAction SilentlyContinue }
    Kill-Port 3001
    Kill-Port 5173
    Kill-Port 5174
}
