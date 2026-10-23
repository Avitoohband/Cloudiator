<#
.SYNOPSIS
  Hosted restore of a Cloudiator export into a new project (Task 24.10, plan 2026-10-20-task-24-launch).

.DESCRIPTION
  Loads <Backup> (a directory written by scripts/export-db.ps1) into the hosted project named by the environment variable
  CLOUDIATOR_RESTORE_DB_URL (the new project's owner connection string), after its migrations were pushed with `db push`.
  The string is never an argument and never printed: scripts/operator-db.mjs parses it and hands the tools only PG*
  variables, and discards libpq's and psql's error text, which can name the host or quote a row. The tools are the
  PostgreSQL 17 pg_restore and psql inside the local container supabase_db_Cloudiator (label com.supabase.cli.project
  Cloudiator verified first). Nothing is downloaded and no container is created.

  Steps:
    1. The SHA-256 of both dump files against manifest.json (nothing is loaded from a damaged backup).
    2. scripts/restore-hosted-facts.sql on the project: it must be new (no account, no character, no season epoch, the
       scheduler off) and at exactly the backup's migrations (checkHostedTarget in scripts/restore-compare.mjs). Anything
       else could be a live database and is refused before any write.
    3. The data dump's listing, kept to HOSTED_RESTORE_DATA (the public and private tables and sequences, auth.users and
       auth.identities); every other entry is left out and reported.
    4. One psql --single-transaction with ON_ERROR_STOP: scripts/restore-hosted-before.sql (the same refusal again, the
       game's triggers off, the migration-seeded rows truncated), the data, scripts/restore-hosted-after.sql (the triggers
       back on, the scheduler off). Any failure rolls back to the state `db push` left.
    5. scripts/restore-invariants.sql on the project (read-only): every table's rows against the manifest and the grant,
       ledger and ownership invariants.
  The Vault secrets, the scheduler and the health check follow by hand (docs/operations/runbook.md, "Hosted restore").

  Output: the JSON report on stdout (counts, checksums, invariants, the entries left out: no connection string, key,
  password or raw error text); progress on stderr. Exit 0 when everything matches, 1 when a check fails after the load,
  2 when the procedure fails or refuses ({"ok":false,"code":...}).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-hosted.ps1 -Backup '<private folder>\backups\20261024T002400Z'
  after setting CLOUDIATOR_RESTORE_DB_URL from a non-echoing prompt (docs/operations/runbook.md, "Entering a connection
  string"); never type or paste the connection string into a command line, which PSReadLine saves to its history file.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Backup
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Container = 'supabase_db_Cloudiator'
$Project = 'Cloudiator'
$UrlVariable = 'CLOUDIATOR_RESTORE_DB_URL'
$Compare = Join-Path $PSScriptRoot 'restore-compare.mjs'
$OperatorDb = Join-Path $PSScriptRoot 'operator-db.mjs'
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$Work = "/tmp/cloudiator-restore-hosted-$Stamp"

function Write-Step([string]$Text) { [Console]::Error.WriteLine("restore-hosted: $Text") }
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

# The local container must be this checkout's Cloudiator stack and running.
function Assert-Container {
  $labels = (Invoke-Checked 'container-missing' 'docker' @('inspect', '-f', '{{json .Config.Labels}}', $Container)) -join "`n"
  $label = ($labels | ConvertFrom-Json).PSObject.Properties['com.supabase.cli.project']
  if ($null -eq $label -or $label.Value -cne $Project) { Fail 'container-not-verified' }
  $running = (Invoke-Checked 'container-missing' 'docker' @('inspect', '-f', '{{.State.Running}}', $Container)) -join ''
  if ($running.Trim() -ne 'true') { Fail 'container-not-running' }
}

# psql inside the container against the hosted project, with only the parsed PG* variables (stderr discarded).
function Invoke-Project([string]$Code, [string[]]$Arguments) {
  $exec = @('exec', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE', $Container)
  return Invoke-Checked $Code 'node' (@($OperatorDb, 'exec', $UrlVariable, 'docker') + $exec + @('psql', '-X', '-v', 'ON_ERROR_STOP=1') + $Arguments)
}

# A restore-compare.mjs command whose refusal (exit 1) carries its own short code in the JSON it prints.
function Invoke-Verdict([string]$Code, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = (& node $Compare @Arguments) -join "`n" } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -eq 0) { return $output }
  if ($LASTEXITCODE -eq 1 -and $output -match '"code":"([a-z-]+)"') { Fail $Matches[1] }
  Fail $Code
}

$exitCode = 2
$hostWork = $null
$containerWork = $false
try {
  # The connection string is parsed and validated before anything else; only its short failure code is shown.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $checked = (& node $OperatorDb check $UrlVariable) -join '' } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) {
    $code = 'invalid-url'
    if ($checked -match '"code":"([a-z-]+)"') { $code = $Matches[1] }
    Fail $code
  }
  # psql runs inside the container, where a loopback host is the container itself, never a hosted project.
  if ($checked -match '"local":true') { Fail 'remote-is-local' }

  if (-not [IO.Path]::IsPathRooted($Backup)) { $Backup = Join-Path $Root $Backup }
  if (-not (Test-Path -LiteralPath $Backup -PathType Container)) { Fail 'backup-missing' }
  if (-not (Test-Path -LiteralPath (Join-Path $Backup 'manifest.json'))) { Fail 'manifest-missing' }

  Write-Step "verifying container $Container"
  Assert-Container

  Write-Step 'verifying the backup checksums'
  $null = Invoke-Verdict 'verify-failed' @('verify', $Backup)

  $hostWork = Join-Path ([IO.Path]::GetTempPath()) "cloudiator-restore-hosted-$Stamp"
  $null = New-Item -ItemType Directory -Path $hostWork
  $null = Invoke-Checked 'container-work-failed' 'docker' @('exec', $Container, 'mkdir', $Work)
  $containerWork = $true
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $Backup 'data.dump'), "${Container}:$Work/data.dump")
  foreach ($file in @('restore-hosted-facts.sql', 'restore-hosted-before.sql', 'restore-hosted-after.sql', 'restore-invariants.sql')) {
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $PSScriptRoot $file), "${Container}:$Work/$file")
  }

  Write-Step 'checking that the project is new and at the backup migrations'
  $null = Invoke-Project 'facts-failed' @('-At', '-o', "$Work/facts.json", '-f', "$Work/restore-hosted-facts.sql")
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/facts.json", (Join-Path $hostWork 'facts.json'))
  $null = Invoke-Verdict 'target-check-failed' @('hosted-target', $Backup, (Join-Path $hostWork 'facts.json'))

  Write-Step 'listing the data to load'
  $null = Invoke-Checked 'list-failed' 'docker' @('exec', $Container, 'pg_restore', '-l', '-f', "$Work/data.toc", "$Work/data.dump")
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/data.toc", (Join-Path $hostWork 'data.toc'))
  $null = Invoke-Checked 'list-failed' 'node' @($Compare, 'hosted-list', $hostWork)
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', (Join-Path $hostWork 'data.list'), "${Container}:$Work/data.list")
  $null = Invoke-Checked 'sql-failed' 'docker' @('exec', $Container, 'pg_restore', '-L', "$Work/data.list", '-f', "$Work/data.sql", "$Work/data.dump")

  Write-Step 'loading the data in one transaction'
  $null = Invoke-Project 'data-restore-failed' @('-q', '--single-transaction', '-f', "$Work/restore-hosted-before.sql",
    '-f', "$Work/data.sql", '-f', "$Work/restore-hosted-after.sql")

  Write-Step 'checking counts and invariants on the project'
  $null = Invoke-Project 'invariants-failed' @('-At', '-o', "$Work/invariants.json", '-f', "$Work/restore-invariants.sql")
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/invariants.json", (Join-Path $hostWork 'invariants.json'))

  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $report = & node $Compare hosted-compare $Backup $hostWork } finally { $ErrorActionPreference = $previous }
  $compared = $LASTEXITCODE
  if ($compared -ne 0 -and $compared -ne 1) { Fail 'compare-failed' }
  [Console]::Out.WriteLine(($report -join "`n"))
  $exitCode = $compared
} catch {
  $message = $_.Exception.Message
  $code = 'restore-hosted-failed'
  if ($message -like 'cloudiator:*') { $code = $message.Substring(11) }
  else { Write-Step "unexpected $($_.Exception.GetType().Name) at line $($_.InvocationInfo.ScriptLineNumber)" }
  [Console]::Out.WriteLine('{"ok":false,"code":"' + $code + '"}')
} finally {
  if ($containerWork) {
    & docker exec $Container rm -rf $Work
    if ($LASTEXITCODE -ne 0) { Write-Step "could not remove $Work in the container" }
  }
  if ($hostWork -and (Test-Path -LiteralPath $hostWork)) { Remove-Item -LiteralPath $hostWork -Recurse -Force }
}
exit $exitCode
