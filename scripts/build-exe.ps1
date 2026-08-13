param(
  [string]$OutputName = "lan-browser.exe"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $ProjectRoot "dist"
$OutputExe = Join-Path $DistDir $OutputName
$BlobFile = Join-Path $DistDir "lan-browser.blob"
$SeaConfig = Join-Path $DistDir "sea-config.json"
$DefaultConfig = Join-Path $ProjectRoot "lan-browser.config.json"
if (-not (Test-Path $DefaultConfig)) {
  $DefaultConfig = Join-Path $ProjectRoot "lan-browser.config.example.json"
}
$OutputConfig = Join-Path $DistDir "lan-browser.config.json"
Set-Location $ProjectRoot
node scripts/bundle.mjs

$Config = @{
  main = (Join-Path $DistDir "app.cjs")
  output = $BlobFile
  disableExperimentalSEAWarning = $true
  useSnapshot = $false
  useCodeCache = $false
} | ConvertTo-Json
[System.IO.File]::WriteAllText($SeaConfig, $Config, [System.Text.UTF8Encoding]::new($false))

node --experimental-sea-config $SeaConfig
$NodeExe = node -p "process.execPath"
[System.IO.File]::Copy($NodeExe, $OutputExe, $true)
node scripts/remove-pe-signature.mjs $OutputExe

node node_modules/postject/dist/cli.js $OutputExe NODE_SEA_BLOB $BlobFile --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
if (-not (Test-Path $OutputConfig)) {
  [System.IO.File]::Copy($DefaultConfig, $OutputConfig)
}
Write-Host "`nBuilt: $OutputExe"
