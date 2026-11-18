param([Parameter(Mandatory=$true)][string]$Config, [Parameter(Mandatory=$true)][string]$Phase)
$ErrorActionPreference = 'Stop'
$c = Get-Content -Raw $Config | ConvertFrom-Json
$root = Split-Path -Parent $Config
# The existing VM kit's Node/MinGit and local-ci's PortableGit are reused.
$dirs = @("$HOME\lci\git\cmd", "$HOME\tools\mingit\cmd", "$HOME\agvm\tools\git\cmd")
$dirs += @(Get-ChildItem "$HOME\tools\node-*","$HOME\agvm\tools\node-*" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
$dirs += @(Get-ChildItem "$HOME\AppData\Local\Programs\Python\Python*" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
$env:Path = ($dirs -join ';') + ';' + $env:Path
function Native([string]$Exe, [string[]]$Argv) {
  & $Exe @Argv | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed: $LASTEXITCODE" }
}
function Archive([string]$Path) {
  if (Test-Path $Path) {
    $a = Join-Path (Split-Path $Path -Parent) ('_archive\' + [Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force $a | Out-Null
    Move-Item $Path $a
  }
}
function Role([string]$Name) {
  $r = $c.$Name
  $env:AGENTGLIM_WORK = Join-Path $r.data 'work'
  $env:AGENTGLIM_PLANS = Join-Path $r.data 'plans'
  $env:AGENTGLIM_RUN = Join-Path $env:AGENTGLIM_PLANS '_run'
  $env:AGENTGLIM_GOALS = Join-Path $r.data 'goals'
  $env:AGENTGLIM_CONFIG = Join-Path $r.data 'harness.json'
  $env:AGENTGLIM_DATA = $r.data; $env:AGENTGLIM_URL = "http://127.0.0.1:$($r.port)"
  Set-Location $r.repo
  return $r
}
function StopServer([string]$Name) {
  $file = Join-Path $root "$Name-pid.json"
  if (!(Test-Path $file)) { return }
  $receipt = Get-Content -Raw $file | ConvertFrom-Json
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($receipt.pid)"
  if ($p) {
    if ($p.CreationDate.ToUniversalTime().ToString('o') -ne $receipt.created) { throw "PID reuse: refusing stop $($receipt.pid)" }
    Stop-Process -Id $p.ProcessId -Force
    for ($i=0; $i -lt 50; $i++) {
      if (!(Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue) { throw 'server did not stop' }
  }
  Archive $file
}
function StartServer([string]$Name) {
  $r = Role $Name
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $script = Join-Path $root 'server.cjs'
  $cl = '"' + $node + '" "' + $script + '" "' + $Config + '" ' + $Name
  $p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine=$cl; CurrentDirectory=$r.repo }
  if ($p.ReturnValue -ne 0) { throw 'server launch failed' }
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ProcessId)"
  if (!$actual) { throw 'server exited before receipt' }
  @{pid=$actual.ProcessId;created=$actual.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $root "$Name-pid.json")
  $ready = $false
  for ($i=0; $i -lt 60; $i++) {
    try { $j = Invoke-RestMethod -TimeoutSec 2 "$env:AGENTGLIM_URL/api/setup"; $ready = $true; break } catch { Start-Sleep 1 }
  }
  if (!$ready) { throw "server not reachable: $Name" }
}
function Checks([string]$Name) {
  $r = Role $Name
  Native node @('tools/first-run.mjs', 'doctor')
  $paths = (& node tools/first-run.mjs paths | Out-String) | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $paths.toolsReady -ne $true -or $paths.restartNeeded) { throw 'tools not ready' }
  $s = Invoke-RestMethod -TimeoutSec 10 "$env:AGENTGLIM_URL/api/setup"
  if ($s.config.setupComplete -ne $true -or $s.paths.restartNeeded) { throw 'Setup incomplete after restart' }
  $head = (& git rev-parse HEAD | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -ne $c.commit) { throw "wrong HEAD: $head" }
  if (Test-Path (Join-Path $r.repo '~')) { throw 'literal tilde directory' }
  return @{doctor_rc=0;toolsReady=$true;setupComplete=$true;restartNeeded=$false;head=$head}
}
$result = @{}
try {
  switch ($Phase) {
    'tools' {
      # Optional offline provisioning assets; existing kit installations are the default.
      New-Item -ItemType Directory -Force "$HOME\agvm\tools" | Out-Null
      if (Test-Path "$root\node.zip") { New-Item -ItemType Directory -Force "$HOME\agvm\tools" | Out-Null; Expand-Archive "$root\node.zip" "$HOME\agvm\tools" }
      if (Test-Path "$root\git.exe") { Native "$root\git.exe" @("-o$HOME\lci\git", '-y') }
      if (Test-Path "$root\python.exe") { $p = Start-Process -Wait -PassThru "$root\python.exe" -ArgumentList '/quiet InstallAllUsers=0 PrependPath=1 Include_test=0'; if ($p.ExitCode -notin @(0,3010)) { throw 'Python install failed' } }
      $result = @{provisioned=$true}
    }
    'probe' {
      Native node @('--version'); Native git @('--version')
      if (!(Test-Path "$HOME\lci\git\bin\bash.exe")) { throw 'baseline needs PortableGit for local-ci: pass --git-exe to vmtest-prep' }
      Native node @('-e', 'if(parseInt(process.versions.node)<22)process.exit(1)')
      $result = @{node=(Get-Command node).Source;git=(Get-Command git).Source}
    }
    'previous-install' {
      $r = $c.previous; Archive (Split-Path $r.repo -Parent)
      New-Item -ItemType Directory -Force (Split-Path $r.repo -Parent) | Out-Null
      Native git @('clone','--branch','main', $c.bundle, $r.repo)
      StartServer previous
      $result = @{installed=$true}
    }
    'fresh-install' {
      Native git @('clone','--branch','main',$c.bundle,$c.fresh.repo)
      if (!(Test-Path "$($c.fresh.repo)\README.md") -or !(Test-Path "$($c.fresh.repo)\SETUP.md")) { throw 'README/SETUP missing' }
      StartServer fresh; $result = @{installed=$true}
    }
    'baseline-check' {
      $r = Role previous
      $head = (& git rev-parse HEAD | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $head -ne $c.previousCommit) { throw 'snapshot previous commit mismatch; run vmtest-prep' }
      if (!(Test-Path "$($r.data)\setup-complete")) { throw 'baseline Setup missing' }
      $result = @{previousCommit=$head}
    }
    'fresh-check' { $result = Checks fresh }
    'previous-check' { $result = Checks previous; StopServer previous }
    'update' {
      $r = Role previous
      # Seed one stable preservation sentinel; compare every existing data path after update and restart.
      [IO.File]::WriteAllText((Join-Path $r.data 'vmtest-preserve.txt'), $c.runid)
      $before = @(Get-ChildItem $r.data -File -Recurse | ForEach-Object { $_.FullName.Substring($r.data.Length + 1) })
      $before | ConvertTo-Json | Set-Content "$root\data-before.json"
      Native git @('remote','set-url','origin',$c.bundle)
      Native npm.cmd @('run','update')
      $head = (& git rev-parse HEAD | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or $head -ne $c.commit) { throw 'update HEAD mismatch' }
      StartServer previous
      $result = @{update_rc=0;head=$head}
    }
    'update-check' {
      $result = Checks previous; $r = $c.previous
      # Windows PowerShell emits a JSON array as one pipeline object. Assign it
      # directly and enumerate with foreach; @(... | ConvertFrom-Json) nests it.
      $before = Get-Content -Raw "$root\data-before.json" | ConvertFrom-Json
      $missing = @(foreach ($relativePath in $before) {
        if ($relativePath -isnot [string]) { throw 'invalid data preservation manifest' }
        if (!(Test-Path -LiteralPath (Join-Path $r.data $relativePath) -PathType Leaf)) { $relativePath }
      })
      if ($missing.Count -ne 0) { throw "data files lost: $($missing -join ',')" }
      if ([IO.File]::ReadAllText((Join-Path $r.data 'vmtest-preserve.txt')) -ne $c.runid) { throw 'preservation sentinel changed' }
      $result.data_files_before=$before.Count; $result.data_files_lost=0
    }
    'stop' { StopServer fresh; StopServer previous; $result = @{stopped=$true} }
    default { throw "unknown phase $Phase" }
  }
  Write-Output ('VMTEST_RESULT=' + ($result | ConvertTo-Json -Depth 12 -Compress))
} catch { Write-Error $_; exit 1 }
