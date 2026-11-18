param([string]$ExpectedVersionPrefix = '')
$ErrorActionPreference = 'Stop'
if ($ExpectedVersionPrefix -and !$PSVersionTable.PSVersion.ToString().StartsWith($ExpectedVersionPrefix)) {
  throw "Expected PowerShell $ExpectedVersionPrefix, got $($PSVersionTable.PSVersion)"
}
# Parse every shipped script, but execute only fixture tests. Never invoke guest.ps1.
$scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File | Sort-Object Name)
foreach ($script in $scripts) {
  $parseErrors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$null, [ref]$parseErrors)
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$tests = @($scripts | Where-Object { $_.Name -like '*.test.ps1' })
if (!$tests.Count) { throw 'No PowerShell fixture tests found' }
$exe = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } elseif ($env:OS -eq 'Windows_NT') { 'pwsh.exe' } else { 'pwsh' }
$exe = Join-Path $PSHOME $exe
Write-Output ("Engine: " + $PSVersionTable.PSVersion)
foreach ($test in $tests) {
  & $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $test.FullName
  if ($LASTEXITCODE -ne 0) { throw "$($test.Name) failed: $LASTEXITCODE" }
}
Write-Output "PASS: $($tests.Count) PowerShell fixture test files; $($scripts.Count) scripts parsed"
