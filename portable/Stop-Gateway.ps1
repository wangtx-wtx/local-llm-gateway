$ErrorActionPreference = 'Stop'

$gatewayHome = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidPath = Join-Path $gatewayHome 'run\gateway.pid'
$expectedNode = [IO.Path]::GetFullPath((Join-Path $gatewayHome 'runtime\node.exe'))

if (-not (Test-Path -LiteralPath $pidPath)) {
  Write-Host 'Local LLM Gateway is not running (no PID file).'
  exit 0
}

$savedPid = 0
$parsedPid = [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$savedPid)
if (-not $parsedPid -or $savedPid -le 0) {
  Remove-Item -LiteralPath $pidPath -Force
  throw 'The PID file was invalid and has been removed.'
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid"
if (-not $process) {
  Remove-Item -LiteralPath $pidPath -Force
  Write-Host 'Gateway was already stopped.'
  exit 0
}

$actualNode = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
$normalizedCommand = ([string]$process.CommandLine).Replace('/', '\')
$isExpected = $actualNode.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -and
  $normalizedCommand.Contains('dist\index.js')
if (-not $isExpected) {
  throw "PID $savedPid does not belong to this portable gateway. Refusing to stop it."
}

Stop-Process -Id $savedPid
for ($attempt = 1; $attempt -le 20; $attempt += 1) {
  if (-not (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host 'Local LLM Gateway stopped.'
