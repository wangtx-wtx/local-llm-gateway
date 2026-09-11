param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'

$gatewayHome = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = Join-Path $gatewayHome 'runtime\node.exe'
$entryPath = Join-Path $gatewayHome 'dist\index.js'
$envPath = Join-Path $gatewayHome '.env'
$envExamplePath = Join-Path $gatewayHome '.env.example'
$runDirectory = Join-Path $gatewayHome 'run'
$logDirectory = Join-Path $gatewayHome 'logs'
$pidPath = Join-Path $runDirectory 'gateway.pid'
$stdoutPath = Join-Path $logDirectory 'gateway.stdout.log'
$stderrPath = Join-Path $logDirectory 'gateway.stderr.log'

function Get-GatewayPort {
  if ($env:LOCAL_GATEWAY_PORT -match '^\d+$') {
    return [int]$env:LOCAL_GATEWAY_PORT
  }
  $port = 8317
  if (Test-Path -LiteralPath $envPath) {
    $line = Get-Content -LiteralPath $envPath -Encoding UTF8 |
      Where-Object { $_ -match '^\s*LOCAL_GATEWAY_PORT\s*=\s*(\d+)\s*$' } |
      Select-Object -Last 1
    if ($line -and $line -match '=\s*(\d+)\s*$') {
      $port = [int]$Matches[1]
    }
  }
  return $port
}

function Test-ExpectedGatewayProcess([int]$ProcessId) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
    if (-not $process) { return $false }
    $expectedNode = [IO.Path]::GetFullPath($nodePath)
    $actualNode = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
    $normalizedCommand = ([string]$process.CommandLine).Replace('/', '\')
    return $actualNode.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -and
      $normalizedCommand.Contains('dist\index.js')
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $nodePath)) {
  throw "The bundled Node.js runtime is missing: $nodePath"
}
if (-not (Test-Path -LiteralPath $entryPath)) {
  throw "The gateway build is missing: $entryPath"
}

New-Item -ItemType Directory -Force -Path $runDirectory, $logDirectory | Out-Null

if (Test-Path -LiteralPath $pidPath) {
  $savedPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedPid)
  if ($savedPid -gt 0 -and (Test-ExpectedGatewayProcess $savedPid)) {
    $port = Get-GatewayPort
    Write-Host "Local LLM Gateway is already running (PID $savedPid)."
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port/admin" }
    exit 0
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path -LiteralPath $envPath)) {
  if (-not (Test-Path -LiteralPath $envExamplePath)) {
    throw "The configuration template is missing: $envExamplePath"
  }
  Copy-Item -LiteralPath $envExamplePath -Destination $envPath
  Write-Host 'Created .env with safe local-only defaults.'
}

$process = Start-Process -FilePath $nodePath `
  -ArgumentList 'dist/index.js' `
  -WorkingDirectory $gatewayHome `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII
$port = Get-GatewayPort
$healthUrl = "http://127.0.0.1:$port/health"

for ($attempt = 1; $attempt -le 40; $attempt += 1) {
  if ($process.HasExited) {
    $details = if (Test-Path -LiteralPath $stderrPath) {
      (Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine
    } else { 'No error log was produced.' }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "Gateway exited during startup.`n$details"
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2 | Out-Null
    Write-Host "Local LLM Gateway started successfully (PID $($process.Id))."
    Write-Host "Dashboard: http://127.0.0.1:$port/admin"
    Write-Host 'Keep gateway.db and master.key together when making backups.'
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port/admin" }
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
throw "Gateway did not become healthy. Check logs\gateway.stderr.log."
