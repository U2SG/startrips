# Existing hourly wake hook; observation never clears owner STOP or grants ownership.
[CmdletBinding()]
param([ValidateSet('check')][string]$Mode = 'check')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$gitDir = Split-Path (Get-Command git.exe -ErrorAction Stop).Source -Parent
$bash = [IO.Path]::GetFullPath((Join-Path $gitDir '..\usr\bin\bash.exe'))
if (-not (Test-Path $bash)) { throw 'Git bash unavailable' }
Push-Location $root
try {
  & $bash (Join-Path $root 'wake-if-work.sh')
  $rc = $LASTEXITCODE
  if ($rc -eq 10) {
    $launcher = Join-Path $root 'launch-supervisor.sh'
    Start-Process -FilePath $bash -ArgumentList ('"' + $launcher + '"') -WorkingDirectory $root -WindowStyle Hidden
  } elseif ($rc -ne 0) {
    Write-Output ('Observation unavailable, no dispatch; next existing tick may retry (rc={0}).' -f $rc)
    exit $rc
  }
} finally { Pop-Location }
