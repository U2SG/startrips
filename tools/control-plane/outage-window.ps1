# Existing network-maintenance tasks; only their own exact boundary is cleared.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('pause','resume')][string]$Mode)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Push-Location $root
try {
  $raw = & python -B -X utf8 (Join-Path $root 'lib/execution.py') ("outage-" + $Mode) $root
  if ($LASTEXITCODE -ne 0) { throw 'Maintenance observation unavailable; owner STOP preserved.' }
  $result = $raw | ConvertFrom-Json
  if ($Mode -eq 'resume' -and $result.launch_allowed) {
    $gitDir = Split-Path (Get-Command git.exe -ErrorAction Stop).Source -Parent
    $bash = [IO.Path]::GetFullPath((Join-Path $gitDir '..\usr\bin\bash.exe'))
    if (-not (Test-Path $bash)) { throw 'Git bash unavailable; nothing launched.' }
    $launcher = Join-Path $root 'launch-supervisor.sh'
    Start-Process -FilePath $bash -ArgumentList ('"' + $launcher + '"') -WorkingDirectory $root -WindowStyle Hidden
  }
  Write-Output $result.reason
} finally { Pop-Location }
