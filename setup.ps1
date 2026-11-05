#requires -Version 7
<#
 One-shot setup of the brain graph on this machine. Safe to run again.

   pwsh -File setup.ps1              install packages, fetch the model, build the graph, run the tests
   pwsh -File setup.ps1 -WhatIf      print the steps and change nothing
   pwsh -File setup.ps1 -SkipTest    skip the self-test
   pwsh -File setup.ps1 -BrainHome <path>  use a different user rules/runtime folder

 Needs: node 20 or newer, npm, and internet (packages from npm, a 23 MB model from huggingface.co).
 Dependencies stay in this checkout. Runtime graphs, vectors, and history are stored under <BrainHome>\brain.
 The hook line in SettingsFile is checked, not edited; see setup.md to configure Codex.
#>
param(
  [switch]$WhatIf,
  [switch]$SkipTest,
  [string]$SettingsFile = (Join-Path $env:USERPROFILE '.codex\hooks.json'),
  [string]$BrainHome = (Join-Path $env:USERPROFILE '.codex')
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$env:BRAIN_HOME = $BrainHome   # keep runtime files in the user's Codex home, separate from this shared checkout
$total = 7
function Step([int]$n, [string]$msg) {
  $bar = ('#' * [int](10 * $n / $total)).PadRight(10, '-')
  Write-Host ("[{0}] {1,3}% step {2}/{3}: {4}" -f $bar, [int](100 * $n / $total), $n, $total, $msg)
}
function Run([string]$what, [string]$exe, [string[]]$cmdArgs) {
  if ($WhatIf) { Write-Host "  (dry run) $what"; return }
  & $exe @cmdArgs
  if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)" }
}
$pin = (Get-Content (Join-Path $here 'package.json') -Raw | ConvertFrom-Json).dependencies.'@huggingface/transformers'

Step 1 'check node and npm'
$nodeVer = (& node --version) -replace '^v', ''
if ([version]($nodeVer -split '-')[0] -lt [version]'20.0') { throw "node $nodeVer is too old, need 20 or newer" }
Write-Host "  node $nodeVer, npm $(& npm --version)"

Step 2 "install packages (@huggingface/transformers $pin)"
$installed = $null
$pkg = Join-Path $here 'node_modules\@huggingface\transformers\package.json'
if (Test-Path $pkg) { $installed = (Get-Content $pkg -Raw | ConvertFrom-Json).version }
if ($installed -eq $pin) { Write-Host "  already installed ($installed)" }
else {
  Push-Location $here
  try {
    $npmCmd = if (Test-Path (Join-Path $here 'package-lock.json')) { 'ci' } else { 'install' }
    Run "npm $npmCmd" 'npm' @($npmCmd, '--omit=dev', '--no-audit', '--no-fund')
  } finally { Pop-Location }
}

Step 3 'remove binaries this machine cannot use (saves about 250 MB)'
$ort = Join-Path $here 'node_modules\onnxruntime-node\bin\napi-v6'
$os = if ($IsWindows) { 'win32' } elseif ($IsMacOS) { 'darwin' } else { 'linux' }
$arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$drop = @()
if (Test-Path $ort) {
  $drop += Get-ChildItem $ort -Directory | Where-Object Name -ne $os
  if (Test-Path (Join-Path $ort $os)) { $drop += Get-ChildItem (Join-Path $ort $os) -Directory | Where-Object Name -ne $arch }
  if ($IsWindows) { $drop += Get-ChildItem (Join-Path $ort "$os\$arch") -File -ErrorAction SilentlyContinue | Where-Object Name -in 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll' }
}
$web = Join-Path $here 'node_modules\onnxruntime-web'
if (Test-Path $web) { $drop += Get-Item $web }
foreach ($d in $drop) { if ($WhatIf) { Write-Host "  (dry run) remove $($d.FullName)" } else { Remove-Item -LiteralPath $d.FullName -Recurse -Force } }
Write-Host "  removed $($drop.Count) item(s); keeping $os/$arch"

Step 4 'build the graph and the meaning numbers (the model comes from git; it is only downloaded if missing)'
Run 'build' 'node' @((Join-Path $here 'brain.js'), 'build', '--require-embeddings')

Step 5 'optional project map'
if (-not $env:MK_DOCS) { Write-Host '  skipped: set MK_DOCS to a docs folder containing graphify-out\graph.json to build the optional project map' }
elseif (-not (Test-Path (Join-Path $env:MK_DOCS 'graphify-out\graph.json'))) { Write-Host '  skipped: MK_DOCS does not contain graphify-out\graph.json' }
elseif ($WhatIf) { Write-Host '  (dry run) node --max-old-space-size=4096 brain.js build-mk' }
else {
  & node --max-old-space-size=4096 (Join-Path $here 'brain.js') 'build-mk'
  if ($LASTEXITCODE) { Write-Host '  project map not built (not fatal); see README.md' }
}
Step 6 'run the self-test'
if ($SkipTest) { Write-Host '  skipped' } else { Run 'self-test' 'node' @((Join-Path $here 'test-brain.js')); Run 'history self-test' 'node' @((Join-Path $here 'test-history.js')); Run 'keyword graph self-test' 'node' @((Join-Path $here 'test-graph.js')); Run 'map self-test' 'node' @((Join-Path $here 'test-mk.js')) }

Step 7 'check the hook line in settings.json'
if (Test-Path $SettingsFile) {
  $s = Get-Content $SettingsFile -Raw
  if ($s -match 'brain[/\\]+brain\.js\\?"? hook') { Write-Host '  hook is in settings.json' }
  else { Write-Host "  MISSING. Add this under hooks.UserPromptSubmit in $SettingsFile :"; Write-Host '    { "hooks": [ { "type": "command", "command": "node \"<path-to-ai-on-prem-brain>/brain.js\" hook", "timeout": 15 } ] }' }
} else { Write-Host "  no settings file at $SettingsFile (see setup.md to configure a hook)" }

if (-not $WhatIf) {
  $mb = { param($p) if (Test-Path $p) { [math]::Round(((Get-ChildItem $p -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1MB) } else { 0 } }
  Write-Host ("`nbrain setup done. node_modules {0} MB (not in git), model and meaning numbers {1} MB (the model is in git)." -f (& $mb (Join-Path $here 'node_modules')), (& $mb (Join-Path $here 'data')))
}
