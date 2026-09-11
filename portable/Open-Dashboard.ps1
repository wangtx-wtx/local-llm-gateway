$ErrorActionPreference = 'Stop'
$gatewayHome = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $gatewayHome '.env'
$port = 8317

if (Test-Path -LiteralPath $envPath) {
  $line = Get-Content -LiteralPath $envPath -Encoding UTF8 |
    Where-Object { $_ -match '^\s*LOCAL_GATEWAY_PORT\s*=\s*(\d+)\s*$' } |
    Select-Object -Last 1
  if ($line -and $line -match '=\s*(\d+)\s*$') {
    $port = [int]$Matches[1]
  }
}

$healthUrl = "http://127.0.0.1:$port/health"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2 | Out-Null
} catch {
  throw 'Gateway is not running. Double-click Start Gateway.cmd first.'
}
Start-Process "http://127.0.0.1:$port/admin"
