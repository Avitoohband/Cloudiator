# Local Docker startup recovery

Avi approved this persistent project supplement on 2026-10-14 for the
Supabase skill's **Supabase CLI** section. Root [AGENTS.md](../../AGENTS.md)
contains the override and standing skill-upkeep policy; vendor caches remain
unchanged. This guide covers the local Windows development runtime.

## Diagnose before changing state

Check the CLI version/help and Docker daemon separately. A successful Desktop
launch command does not prove its backend started. Inspect process metadata and
the diagnostic message in `%LOCALAPPDATA%/Docker/backend.error.json` when startup
fails. Read bounded error fields, excluding settings, tokens and credential
contents. Do not print raw Supabase status or gateway configuration.

The observed failure was Windows error1920 (`ERROR_CANT_ACCESS_FILE`) while
renaming `%LOCALAPPDATA%/docker-secrets-engine/engine.sock` to `engine.sock.stale`.
Metadata showed one zero-byte file with Archive/ReparsePoint attributes;
`fsutil reparsepoint query` also returned1920. Docker's error identified the
socket listener, not database corruption. The same symptom and directory-level
workaround are reported in [Docker for Windows issue15064](https://github.com/docker/for-win/issues/15064).
That report is supporting evidence, not a guarantee for other failures.

## Preserve only the confirmed runtime directory

1. Confirm the daemon failed and no unrelated Docker workload is running. Use
   current installed help for `docker desktop stop`. The verified invocation
   was `docker desktop stop --force --timeout 20`; its force-stop completed.
   Confirm no `Docker Desktop` or `com.docker.backend` process remains before
   filesystem changes. Do not force-stop a healthy shared runtime casually.
2. Resolve the exact directory and its intended parent to absolute paths.
   Inspect immediate metadata only. For this recovery, require exactly one
   entry named `engine.sock`, length0, with ReparsePoint attributes. If there
   are other contents or a different error, stop this recipe and diagnose.
   Never read the socket, follow a reparse target or infer that a directory
   named for secrets contains only sockets.
3. Choose a fresh sibling backup name, verify it does not exist, then use
   native PowerShell `Rename-Item -LiteralPath` on the verified directory.
   Preserve the directory intact. Do not recursively delete files, reset
   Docker, unregister WSL, modify service permissions or touch VM disks,
   volumes, settings or credential stores as part of this recovery.
4. Verify the backup exists. Launch the installed `Docker Desktop.exe` with
   `Start-Process -WindowStyle Hidden`. Allow initialization, then run
   `docker version --format '{{.Server.Version}}'`; check the result and exit
   status. If another error appears, inspect it instead of repeating mutations.
5. Once the daemon is available, independently verify the local Supabase
   container's `com.supabase.cli.project=Cloudiator` label before starting or
   resetting the test stack. Use this checkout's private worker configuration;
   no credential copying from another agent. Resume required database/Auth/HTTP
   and migration-only replay checks. Daemon recovery alone proves none of them.

## Observed evidence and limits

On2026-10-14, Docker Desktop4.94.0 startup failed on the exact socket rename.
The guards above passed. Its runtime directory was preserved as
`C:/Users/Avi_OP_PC/AppData/Local/docker-secrets-engine.cloudiator-stale-20261014-1`.
No files were deleted. After a hidden restart, the daemon probe returned
Engine29.8.2, Desktop/backend processes were running and the error report had
disappeared. Task10 then verified the Cloudiator label and resumed its own stack.

On 2026-10-16 the same failure recurred after a restart. The nested error
named component `services`, "initializing Secrets Engine", and an
`*os.LinkError` renaming the same `engine.sock` to `engine.sock.stale`. The
`syscall.Errno` value was not present in the JSON. After the documented
force-stop, no Desktop or backend process remained. The directory again held
exactly one zero-byte `engine.sock` with Archive/ReparsePoint attributes. It
was preserved as
`C:/Users/Avi_OP_PC/AppData/Local/docker-secrets-engine.cloudiator-stale-20261016-1`.
After a hidden launch, Engine 29.8.2 answered and the error report was gone.
The Cloudiator label was verified before the stack was started.

On 2026-10-19, after the host restarted overnight, Docker Desktop was not running. A hidden launch
failed the same way: component `services`, "initializing Secrets Engine", an `*os.LinkError` renaming
`engine.sock` to `engine.sock.stale` ("The file cannot be accessed by the system"). The documented
force-stop reported Desktop not running, and no Desktop or backend process remained. The directory again
held exactly one zero-byte `engine.sock` with Archive/ReparsePoint attributes. It was preserved as
`C:/Users/Avi_OP_PC/AppData/Local/docker-secrets-engine.cloudiator-stale-20261019-1`. After a hidden
launch, Engine 29.8.2 answered within 5 s and the error report was gone. The containers labelled
`com.supabase.cli.project=Cloudiator` were verified before `supabase start` (output suppressed) and the
background Edge serve were restarted. This is the third observed occurrence; each followed a Desktop
or host restart.

On 2026-10-19 after the next host reboot (08:33 IDT), a hidden launch started Engine 29.8.2 within 5 s
with no error report: the freshly recreated `docker-secrets-engine` directory did not repeat the failure.
The recovery is therefore needed only when the stale socket survives a restart, not on every boot.

This is a tested workaround on this host, not a permanent Docker fix. The
preserved backup is not a database export and remains outside the repository.
No full-Docker reset, upgrade, data-directory cleanup or removal of that backup
is authorized by this guide. Keep new observations distinct from the evidence
above and propose substantive reusable changes under Avi's upkeep policy.

Reference: the installed help matched Docker's documented
[Desktop stop command](https://docs.docker.com/reference/cli/docker/desktop/stop/).
