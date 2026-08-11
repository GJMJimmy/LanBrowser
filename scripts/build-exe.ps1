$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $ProjectRoot "dist"
$OutputExe = Join-Path $DistDir "lan-browser.exe"
$BlobFile = Join-Path $DistDir "lan-browser.blob"
$SeaConfig = Join-Path $DistDir "sea-config.json"
$DefaultConfig = Join-Path $ProjectRoot "lan-browser.config.json"
$OutputConfig = Join-Path $DistDir "lan-browser.config.json"
$AudioDir = Join-Path $ProjectRoot "vendor\audio"
$NAudioDll = Join-Path $ProjectRoot "vendor\naudio\NAudio.dll"
$AudioHelper = Join-Path $AudioDir "LanBrowser.AudioCapture.exe"
$CSharpCompiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

Set-Location $ProjectRoot
New-Item -ItemType Directory -Force -Path $AudioDir | Out-Null
if (-not (Test-Path $CSharpCompiler)) { throw "未找到 Windows C# 编译器: $CSharpCompiler" }
& $CSharpCompiler /nologo /optimize+ /target:exe /platform:x64 "/out:$AudioHelper" "/reference:$NAudioDll" (Join-Path $ProjectRoot "src\audio-helper.cs")
if ($LASTEXITCODE -ne 0) { throw "音频采集组件编译失败" }
[System.IO.File]::Copy($NAudioDll, (Join-Path $AudioDir "NAudio.dll"), $true)
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

node node_modules/postject/dist/cli.js $OutputExe NODE_SEA_BLOB $BlobFile --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
if (-not (Test-Path $OutputConfig)) {
  [System.IO.File]::Copy($DefaultConfig, $OutputConfig)
}
Write-Host "`nBuilt: $OutputExe"
