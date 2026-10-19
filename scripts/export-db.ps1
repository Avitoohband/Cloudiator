<#
.SYNOPSIS
  Weekly operator export of the Cloudiator database (Task 22.4, plan 2026-10-18-task-22-retention-operations, Decision 9).

.DESCRIPTION
  Writes <OutDir>/<UTC yyyyMMddTHHmmssZ>/ with:
    schema.dump    pg_dump --schema-only, custom format (the whole database: app, Auth and platform schemas)
    data.dump      pg_dump --data-only, custom format (auth.users included; the excluded table data is listed in the manifest)
    manifest.json  git commit, applied migrations, server version, the COPY row count of every public and private table plus
                   auth.users in data.dump, the excluded table data, and the SHA-256 of both dump files
  The dumps run with the PostgreSQL 17 tools inside the local container supabase_db_Cloudiator (docker exec), whose label
  com.supabase.cli.project must be Cloudiator. Nothing is downloaded and no container is created.

  Local (default): dumps the local stack's postgres database as the postgres role over the container's local socket.
  -Remote: dumps the database named by the environment variable CLOUDIATOR_EXPORT_DB_URL (the database owner's connection
  string). The string is never an argument and never printed: scripts/operator-db.mjs parses it (one '@', no ',', a plain host)
  and hands pg_dump only PG* variables; libpq's own error text is discarded because it names the host. TLS is 'require'
  unless the URL sets sslmode (see docs/operations/runbook.md, "Weekly export").

  Output: one JSON summary on stdout; progress on stderr. Exit 0 on success, 2 on failure with {"ok":false,"code":...}.
  A failed run removes the backup directory it created. .backups/ is git-ignored.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-db.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-db.ps1 -Remote
  after setting CLOUDIATOR_EXPORT_DB_URL from a non-echoing prompt (docs/operations/runbook.md, "Entering a connection
  string"); never type or paste the connection string into a command line, which PSReadLine saves to its history file.
#>
[CmdletBinding()]
param(
  [string]$OutDir = '.backups',
  [switch]$Remote
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Container = 'supabase_db_Cloudiator'
$Project = 'Cloudiator'
$UrlVariable = 'CLOUDIATOR_EXPORT_DB_URL'
$Compare = Join-Path $PSScriptRoot 'restore-compare.mjs'
$OperatorDb = Join-Path $PSScriptRoot 'operator-db.mjs'
$Stamp = [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$Work = "/tmp/cloudiator-export-$Stamp"

function Write-Step([string]$Text) { [Console]::Error.WriteLine("export-db: $Text") }
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

# A libpq tool inside the container: as postgres over the local socket, or (-Remote) with the parsed PG* variables.
function Invoke-InContainer([string]$Code, [string[]]$Tool) {
  if ($Remote) {
    $exec = @('exec', '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGDATABASE', '-e', 'PGSSLMODE', $Container)
    return Invoke-Checked $Code 'node' (@($OperatorDb, 'exec', $UrlVariable, 'docker') + $exec + $Tool)
  }
  return Invoke-Checked $Code 'docker' (@('exec', $Container) + $Tool[0] + @('-U', 'postgres', '-d', 'postgres') + $Tool[1..($Tool.Length - 1)])
}

$exitCode = 2
$backupDir = $null
$hostWork = $null
$created = $false
$containerWork = $false
try {
  if ($Remote) {
    # The connection string is parsed and validated before anything is created; only its short failure code is shown.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $checked = (& node $OperatorDb check $UrlVariable) -join '' } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) {
      $code = 'invalid-url'
      if ($checked -match '"code":"([a-z-]+)"') { $code = $Matches[1] }
      Fail $code
    }
    # pg_dump runs inside the container, where a loopback host is the container itself: the local stack uses the default mode.
    if ($checked -match '"local":true') { Fail 'remote-is-local' }
  }
  if (-not [IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $Root $OutDir }
  $backupDir = Join-Path $OutDir $Stamp
  if (Test-Path -LiteralPath $backupDir) { Fail 'backup-exists' }

  Write-Step "verifying container $Container"
  Assert-Container

  $null = New-Item -ItemType Directory -Path $backupDir
  $created = $true
  $hostWork = Join-Path ([IO.Path]::GetTempPath()) "cloudiator-export-$Stamp"
  $null = New-Item -ItemType Directory -Path $hostWork
  $null = Invoke-Checked 'container-work-failed' 'docker' @('exec', $Container, 'mkdir', $Work)
  $containerWork = $true

  $exclusions = @(Invoke-Checked 'exclusions-failed' 'node' @($Compare, 'dump-args'))
  Write-Step 'dumping the schema'
  $null = Invoke-InContainer 'schema-dump-failed' @('pg_dump', '--format=custom', '--schema-only', "--file=$Work/schema.dump")
  Write-Step 'dumping the data'
  $null = Invoke-InContainer 'data-dump-failed' (@('pg_dump', '--format=custom', '--data-only') + $exclusions + @("--file=$Work/data.dump"))
  $facts = "select jsonb_build_object('serverVersion',current_setting('server_version'),'migrations',coalesce((select jsonb_agg(" +
    "jsonb_build_object('version',version,'name',name) order by version) from supabase_migrations.schema_migrations),'[]'::jsonb))::text"
  $null = Invoke-InContainer 'facts-failed' @('psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-o', "$Work/facts.json", '-c', $facts)

  Write-Step 'copying the dumps out of the container'
  foreach ($file in @('schema.dump', 'data.dump')) {
    $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/$file", (Join-Path $backupDir $file))
  }
  $null = Invoke-Checked 'copy-failed' 'docker' @('cp', "${Container}:$Work/facts.json", (Join-Path $hostWork 'facts.json'))

  Write-Step 'writing the manifest'
  $source = 'local'
  if ($Remote) { $source = 'remote' }
  $summary = Invoke-Checked 'manifest-failed' 'node' @($Compare, 'manifest', $backupDir, (Join-Path $hostWork 'facts.json'), $source, "$Work/data.dump")
  [Console]::Out.WriteLine(($summary -join "`n"))
  $exitCode = 0
} catch {
  $message = $_.Exception.Message
  $code = 'export-failed'
  if ($message -like 'cloudiator:*') { $code = $message.Substring(11) }
  else { Write-Step "unexpected $($_.Exception.GetType().Name) at line $($_.InvocationInfo.ScriptLineNumber)" }
  [Console]::Out.WriteLine('{"ok":false,"code":"' + $code + '"}')
  if ($created -and $backupDir -and (Test-Path -LiteralPath $backupDir)) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
} finally {
  if ($containerWork) {
    & docker exec $Container rm -rf $Work
    if ($LASTEXITCODE -ne 0) { Write-Step "could not remove $Work in the container" }
  }
  if ($hostWork -and (Test-Path -LiteralPath $hostWork)) { Remove-Item -LiteralPath $hostWork -Recurse -Force }
}
exit $exitCode
