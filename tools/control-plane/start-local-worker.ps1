# Explicit local-user entrypoint. Check never clears STOP or starts a worker.
[CmdletBinding()]
param([ValidateSet('Check','Resume')][string]$Mode = 'Check')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$gitDir = Split-Path (Get-Command git.exe -ErrorAction Stop).Source -Parent
$bash = [IO.Path]::GetFullPath((Join-Path $gitDir '..\usr\bin\bash.exe'))
if (-not (Test-Path $bash)) { throw 'Git bash is unavailable; no worker was started.' }
Push-Location $root
try {
  & python -B -X utf8 (Join-Path $root 'lib/execution.py') check $root --lane backend
  if ($LASTEXITCODE -ne 0) { throw 'Existing or unknown execution; no duplicate worker.' }
  & python -B -X utf8 (Join-Path $root 'lib/policy_audit.py') $root
  if ($LASTEXITCODE -ne 0) { throw 'Control-plane contract audit failed.' }
  & $bash -c 'export PATH="/usr/bin:$PATH"; export STARTRIPS_LANE=backend; ./run-loop.sh --next'
  if ($LASTEXITCODE -ne 0) { throw 'Target bash did not receive a valid Backend lane.' }
  if ($Mode -eq 'Check') {
    Write-Output 'READY_FOR_EXPLICIT_RESUME: STOP is preserved; no worker started.'
    return
  }
  & python -B -X utf8 (Join-Path $root 'lib/execution.py') permission $root
  if ($LASTEXITCODE -ne 0) { throw 'Actual workspace write probe failed; permissions were not widened.' }
  $oldResume = $env:STARTRIPS_EXPLICIT_RESUME
  try {
    $env:STARTRIPS_EXPLICIT_RESUME = '1'
    & python -B -X utf8 (Join-Path $root 'lib/execution.py') resume $root
    if ($LASTEXITCODE -ne 0) { throw 'Explicit Resume refused; inspect STOP/ownership evidence.' }
  } finally { $env:STARTRIPS_EXPLICIT_RESUME = $oldResume }
  $launcher = Join-Path $root 'launch-supervisor.sh'
  Start-Process -FilePath $bash -ArgumentList ('"' + $launcher + '"') -WorkingDirectory $root -WindowStyle Hidden
  Write-Output 'START_REQUESTED: the existing launcher rechecks STOP and execution ownership.'
} finally { Pop-Location }

