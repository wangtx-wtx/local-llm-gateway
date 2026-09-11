param(
  [string]$NodeVersion = '24.21.0',
  [ValidateSet('x64')]
  [string]$Architecture = 'x64',
  [string]$OutputDirectory = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$releaseName = "local-llm-gateway-v$($package.version)-windows-$Architecture-portable"
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$stageRoot = Join-Path $outputRoot $releaseName
$zipPath = Join-Path $outputRoot "$releaseName.zip"
$downloadRoot = Join-Path ([IO.Path]::GetTempPath()) 'local-llm-gateway-node-runtime'
$nodeArchiveName = "node-v$NodeVersion-win-$Architecture.zip"
$nodeArchivePath = Join-Path $downloadRoot $nodeArchiveName
$nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$repoPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must stay inside the repository.'
}
if (-not $stageRoot.StartsWith($outputRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Invalid portable staging path.'
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\index.js'))) {
  throw 'dist/index.js is missing. Run npm run build:all first.'
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'web\dist\index.html'))) {
  throw 'web/dist/index.html is missing. Run npm run build:all first.'
}

New-Item -ItemType Directory -Force -Path $outputRoot, $downloadRoot | Out-Null
Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$zipPath.sha256" -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/SHASUMS256.txt").Content
$checksumLine = ($checksums -split "`n") | Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))\s*$" }
if (-not $checksumLine) {
  throw "Official checksum not found for $nodeArchiveName"
}
$expectedHash = ($checksumLine.Trim() -split '\s+')[0].ToUpperInvariant()

if (-not (Test-Path -LiteralPath $nodeArchivePath) -or
    (Get-Sha256 $nodeArchivePath) -ne $expectedHash) {
  Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchivePath
}
$actualHash = Get-Sha256 $nodeArchivePath
if ($actualHash -ne $expectedHash) {
  throw "Node.js archive checksum mismatch. Expected $expectedHash, got $actualHash"
}

$extractRoot = Join-Path $downloadRoot "node-v$NodeVersion-win-$Architecture"
$expectedExtractPrefix = $downloadRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $extractRoot.StartsWith($expectedExtractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Invalid Node.js extraction path.'
}
Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $downloadRoot -Force

New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'runtime') | Out-Null
Copy-Item -LiteralPath (Join-Path $extractRoot 'node.exe') -Destination (Join-Path $stageRoot 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $extractRoot 'LICENSE') -Destination (Join-Path $stageRoot 'runtime\NODE-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $repoRoot 'dist') -Destination $stageRoot -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot 'web') | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'web\dist') -Destination (Join-Path $stageRoot 'web') -Recurse
Copy-Item -Path (Join-Path $repoRoot 'portable\*') -Destination $stageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot '.env.example') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stageRoot

$forbiddenNames = @('.env', 'gateway.db', 'gateway.db-wal', 'gateway.db-shm', 'master.key')
$forbidden = Get-ChildItem -LiteralPath $stageRoot -Recurse -Force | Where-Object {
  $forbiddenNames -contains $_.Name -or $_.Extension -in @('.pfx', '.p12', '.pem')
}
if ($forbidden) {
  throw "Sensitive runtime file entered the package: $($forbidden.FullName -join ', ')"
}

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-Sha256 $zipPath).ToLowerInvariant()
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ASCII

Write-Host "Portable package: $zipPath"
Write-Host "SHA-256: $zipHash"
