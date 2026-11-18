$ErrorActionPreference = 'Stop'
# Execute the actual guest update-check body, with no VM, server or native command.
$guest = Join-Path $PSScriptRoot 'guest.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($guest, [ref]$null, [ref]$null)
$switch = $ast.Find({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] }, $true)
$clause = $switch.Clauses | Where-Object { $_.Item1.Value -eq 'update-check' }
$text = $clause.Item2.Extent.Text
$check = [scriptblock]::Create($text.Substring(1, $text.Length - 2))
function Checks { return @{doctor_rc=0;toolsReady=$true} }

# Windows PowerShell 5.1 emits a JSON array as a single pipeline object. Emulate
# that behavior on pwsh too, so Linux CI can catch the Windows-only regression.
function ConvertFrom-Json {
  param([Parameter(ValueFromPipeline=$true)][string]$InputObject)
  process {
    $decoded = @(Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $InputObject | ForEach-Object { $_ })
    if ($legacyArrays) { Write-Output -NoEnumerate $decoded } else { $decoded }
  }
}
$base = Join-Path ([IO.Path]::GetTempPath()) ('agvm-preservation-' + [Guid]::NewGuid())
New-Item -ItemType Directory $base | Out-Null
$cases = 0
foreach ($legacyArrays in @($false, $true)) {
  foreach ($json in @('[]', '["vmtest-preserve.txt"]', '["vmtest-preserve.txt","control/control.db","space and [brackets].txt"]')) {
    $root = Join-Path $base ([Guid]::NewGuid().ToString())
    $data = Join-Path $root 'data'
    New-Item -ItemType Directory -Force (Join-Path $data 'control') | Out-Null
    $c = @{previous=@{data=$data};runid='fixture-preservation'}
    [IO.File]::WriteAllText((Join-Path $data 'vmtest-preserve.txt'), $c.runid)
    [IO.File]::WriteAllText((Join-Path $root 'data-before.json'), $json)
    $names = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $json
    foreach ($name in $names) {
      if ($name -ne 'vmtest-preserve.txt') { [IO.File]::WriteAllText((Join-Path $data $name), 'fixture') }
    }
    . $check
    if ($result.data_files_before -ne $names.Count -or $result.data_files_lost -ne 0) { throw 'wrong preserved file counts' }
    $cases++
    if ($names.Count -gt 1) {
      # Archive a file, and prove the real check still rejects data loss.
      Move-Item -LiteralPath (Join-Path $data 'control/control.db') -Destination (Join-Path $root 'archived-control.db')
      $errorText = ''
      try { . $check } catch { $errorText = $_.Exception.Message }
      if ($errorText -notlike 'data files lost:*control/control.db*') { throw "missing data was not detected: $errorText" }
      $cases++
    } else {
      [IO.File]::WriteAllText((Join-Path $data 'vmtest-preserve.txt'), 'changed')
      $errorText = ''
      try { . $check } catch { $errorText = $_.Exception.Message }
      if ($errorText -ne 'preservation sentinel changed') { throw "changed sentinel was not detected: $errorText" }
      $cases++
    }
  }
}
Write-Output "PASS: $cases data preservation cases (native and Windows PowerShell array behavior)"
