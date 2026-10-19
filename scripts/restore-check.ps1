<#
.SYNOPSIS
  Restore check of a Cloudiator export (Task 22.4, plan 2026-10-18-task-22-retention-operations, Decision 9).

.DESCRIPTION
  Restores <Backup> (a directory written by scripts/export-db.ps1) into the separate database cloudiator_restore_check inside
  the local container supabase_db_Cloudiator, after verifying the container's label com.supabase.cli.project=Cloudiator.
  It refuses any other database name, never touches the postgres database's data, roles or extensions, and never resets
  the stack. Only the PostgreSQL 17 tools already in that container are used (docker exec, docker cp).

  Steps:
    1. The SHA-256 of both dump files against manifest.json (nothing is restored from a damaged backup).
    2. drop database if exists cloudiator_restore_check; create it from template0.
    3. The schema, then the data, each with psql -v ON_ERROR_STOP=1 --single-transaction. The data loads with
       session_replication_role=replica (no trigger or foreign-key trigger fires during the load; restore-invariants.sql
       then checks every foreign key). The only objects left out are pg_cron's (RESTORE_EXCLUSIONS in
       scripts/restore-compare.mjs and docs/operations/runbook.md): pg_cron can exist only in the postgres database.
    4. scripts/restore-invariants.sql: every table's rows and the grant, ledger and ownership invariants.
    5. scripts/restore-resume.sql: a structural replay (the coordinator lease as the code takes it, then advance_boundary
       on the last published slot, which must answer 'replayed'; it returns before any grant table), then guard probes in
       rolled-back subtransactions (a second settlement must hit the settled-slot primary key; deleting a settled slot or a
       receipt must hit its guard), then unchanged counts, no new grant and no lost item.
    6. Drops cloudiator_restore_check (unless -Keep), then prints the JSON report of scripts/restore-compare.mjs.

  Output: the JSON report on stdout (counts, checksums, invariants, resume, duplicateGrants, lostItems: no connection
  string, key, password or raw error text); progress on stderr. Exit 0 when everything matches, 1 when a check fails, 2
  when the procedure fails ({"ok":false,"code":...}).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-check.ps1 -Backup .backups/20261019T061500Z
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Backup,
  [string]$Database = 'cloudiator_restore_check',
  [switch]$Keep
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Container = 'supabase_db_Cloudiator'
$Project = 'Cloudiator'
$Target = 'cloudiator_restore_check'
$Compare = Join-Path $PSScriptRoot 'restore-compare.mjs'
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$Work = "/tmp/cloudiator-restore-$Stamp"

function Write-Step([string]$Text) { [Console]::Error.WriteLine("restore-check: $Text") }
function Fail([string]$Code) { throw (New-Object System.Exception "cloudiator:$Code") }

# Runs a native command; output is returned, a non-zero exit throws the given short code. Native stderr is not redirected,
# so Windows PowerShell 5.1 never turns it into error records.
function Invoke-Checked([string]$Code, [string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & $File @Arguments } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { Fail $Code }
  return $output
}
function Assert-Container {
  $labels = (Invoke-Checked 'container-missing' 'docker' @('inspect', '-f', '{{json .Config.Labels}}', $Container)) -join "`n"
  $label = ($labels | ConvertFrom-Json).PSObject.Properties['com.supabase.cli.project']
  if ($null -eq $label -or $label.Value -cne $Project) { Fail 'container-not-verified' }
  $running = (Invoke-Checked 'container-missing' 'docker' @('inspect', '-f', '{{.State.Running}}', $Container)) -join ''
  if ($running.Trim() -ne 'true') { Fail 'container-not-running' }
}
# psql inside the container. The target database is always the constant $Target; the maintenance connection is postgres.
function Invoke-Psql([string]$Code, [string]$Role, [string]$Db, [string[]]$Arguments) {
  if ($Db -cne $Target -and $Db -cne 'postgres') { Fail 'database-not-allowed' }
  return Invoke-Checked $Code 'docker' (@('exec', $Container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', $Role, '-d', $Db) + $Arguments)
}
function Remove-RestoreDatabase {
  $null = Invoke-Psql 'drop-failed' 'supabase_admin' 'postgres' @('-c', "drop database if exists $Target with (force)")
}

$exitCode = 2
$script:VerifyStatus = 2
$script:VerifyOutput = ''
$hostWork = $null
$containerWork = $false
$databaseCreated = $false
$databaseState = 'dropped'
try {
  # Refuse before touching anything: only the one restore-check database, only a backup directory with a manifest.
  if ($Database -cne $Target) { Fail 'database-not-allowed' }
  if (-not (Test-Path -LiteralPath $Backup -PathType Container)) { Fail 'backup-missing' }
  $Backup = (Resolve-Path -LiteralPath $Backup).ProviderPath
  if (-not (Test-Path -LiteralPath (Join-Path $Backup 'manifest.json') -PathType Leaf)) { Fail 'manifest-missing' }

  Write-Step "verifying container $Container"
  Assert-Container

  Write-Step 'verifying the backup checksums'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $verified = & node $Compare verify $Backup } finally { $ErrorActionPreference = $previous }
  $script:VerifyStatus = $LASTEXITCODE
  $script:VerifyOutput = $verified -join "`n"
  if ($script:VerifyStatus -ne 0) { Fail 'verify' }

  $hostWork = Join-Path ([IO.Path]::GetTempPath()) "cloudiator-restore-$Stamp"
  $null = New-Item -ItemType Directory -Path $hostWork
  $null = Invoke-Checked 'container-work-failed' 'docker' @('exec', $Container, 'mkdir', $Work)
  $containerWork = $true
  foreach ($file in @('schema.dump', 'data.dump')) {
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $Backup $file), "${Container}:$Work/$file")
  }
  foreach ($file in @('restore-invariants.sql', 'restore-resume.sql')) {
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $PSScriptRoot $file), "${Container}:$Work/$file")
  }

  Write-Step "recreating $Target"
  Remove-RestoreDatabase
  $databaseCreated = $true
  $null = Invoke-Psql 'create-failed' 'supabase_admin' 'postgres' @('-c', "create database $Target template template0")

  # The listings, minus the documented exclusions, then the SQL pg_restore would run, applied by psql with ON_ERROR_STOP.
  foreach ($kind in @('schema', 'data')) {
    $null = Invoke-Checked 'list-failed' 'docker' @('exec', $Container, 'pg_restore', '-l', '-f', "$Work/$kind.toc", "$Work/$kind.dump")
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/$kind.toc", (Join-Path $hostWork "$kind.toc"))
    $null = Invoke-Checked 'exclude-failed' 'node' @($Compare, 'exclude', $hostWork, $kind)
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $hostWork "$kind.list"), "${Container}:$Work/$kind.list")
    $null = Invoke-Checked 'sql-failed' 'docker' @('exec', $Container, 'pg_restore', '-L', "$Work/$kind.list", '-f', "$Work/$kind.sql", "$Work/$kind.dump")
  }
  Write-Step 'restoring the schema'
  $null = Invoke-Psql 'schema-restore-failed' 'supabase_admin' $Target @('--single-transaction', '-f', "$Work/schema.sql")
  Write-Step 'restoring the data'
  $null = Invoke-Psql 'data-restore-failed' 'supabase_admin' $Target @('--single-transaction', '-c', 'set session_replication_role = replica', '-f', "$Work/data.sql")

  Write-Step 'checking counts and invariants'
  $null = Invoke-Psql 'invariants-failed' 'supabase_admin' $Target @('-At', '-o', "$Work/invariants.json", '-f', "$Work/restore-invariants.sql")
  Write-Step 'replaying the last published boundary'
  $null = Invoke-Psql 'resume-failed' 'postgres' $Target @('-At', '-o', "$Work/resume.json", '-f', "$Work/restore-resume.sql")
  foreach ($file in @('invariants.json', 'resume.json')) {
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/$file", (Join-Path $hostWork $file))
  }

  if ($Keep) {
    $databaseState = 'kept'
  } else {
    Write-Step "dropping $Target"
    Remove-RestoreDatabase
    $databaseCreated = $false
  }

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $report = & node $Compare compare $Backup $hostWork $databaseState } finally { $ErrorActionPreference = $previous }
  $status = $LASTEXITCODE
  [Console]::Out.WriteLine(($report -join "`n"))
  $exitCode = 2
  if ($status -eq 0 -or $status -eq 1) { $exitCode = $status }
} catch {
  $message = $_.Exception.Message
  $code = 'restore-check-failed'
  if ($message -like 'cloudiator:*') { $code = $message.Substring(11) }
  else { Write-Step "unexpected $($_.Exception.GetType().Name) at line $($_.InvocationInfo.ScriptLineNumber)" }
  if ($code -eq 'verify') {
    # The checksum verdict (exit 1) or the comparison module's own short code (exit 2), as it printed them.
    [Console]::Out.WriteLine($script:VerifyOutput)
    if ($script:VerifyStatus -eq 1) { $exitCode = 1 }
  } else {
    [Console]::Out.WriteLine('{"ok":false,"code":"' + $code + '"}')
  }
} finally {
  if ($databaseCreated -and -not $Keep) {
    try { Remove-RestoreDatabase } catch { Write-Step "could not drop $Target" }
  }
  if ($containerWork) {
    & docker exec $Container rm -rf $Work
    if ($LASTEXITCODE -ne 0) { Write-Step "could not remove $Work in the container" }
  }
  if ($hostWork -and (Test-Path -LiteralPath $hostWork)) { Remove-Item -LiteralPath $hostWork -Recurse -Force }
}
exit $exitCode
