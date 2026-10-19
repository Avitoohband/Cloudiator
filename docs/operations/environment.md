# Environments

Task 22.4. Where each Cloudiator environment runs, which ports and worktrees it uses, which environment variables exist and
where every secret lives. **Names only: no value of a key, token, password or connection string belongs in this file or
anywhere in the repository.** Operations are in `docs/operations/runbook.md`.

## Local stack

One local Supabase stack (CLI project id `Cloudiator`, `supabase/config.toml`) serves every worktree on this host.

| Item | Value |
|---|---|
| Supabase CLI | 2.120.0, pinned as an npm dev dependency; run it with `npx supabase …` and check `--help` before new flags |
| Docker | Docker Desktop 4.94.0, Engine 29.8.2 (start-up recovery: `docs/operations/local-runtime.md`) |
| Database image | PostgreSQL 17.11 (`public.ecr.aws/supabase/postgres:17.11.0.004`), extensions pg_cron 1.6.4, pg_net 0.20.4, supabase_vault, pgcrypto, uuid-ossp, pg_stat_statements |
| Containers | `supabase_db_Cloudiator`, `supabase_auth_Cloudiator`, `supabase_rest_Cloudiator`, `supabase_kong_Cloudiator`, `supabase_edge_runtime_Cloudiator`; each carries the label `com.supabase.cli.project=Cloudiator` |
| Disabled services | Studio, Realtime, Storage, analytics, local SMTP (`config.toml`; `npx supabase start --exclude studio,realtime,storage-api,imgproxy,mailpit,logflare,vector,supavisor`) |
| Seed | none (`[db.seed] enabled = false`); `db reset --local --no-seed --yes` replays M01–M16 |
| Edge functions | `game-command` (JWT verified by the gateway) and `game-worker` (no JWT; the worker secret is the authorization), served with `npx supabase functions serve --env-file .env.edge.local` from one worktree |
| Scheduler | `private.scheduler.enabled = false` locally and no Vault worker secrets, so pg_cron's two jobs run but stay inert and nothing is dispatched |

Before any script or manual command touches the database container, check its label:
`docker inspect -f '{{json .Config.Labels}}' supabase_db_Cloudiator` must contain `"com.supabase.cli.project":"Cloudiator"`
(the export and restore-check scripts do this themselves). Never print `supabase status`: it contains local keys. Scripts that
need the local URLs read it in memory (`scripts/test-db.mjs`, `scripts/health.mjs`) and refuse non-loopback hosts.

### Ports (all on 127.0.0.1)

| Port | Use |
|---|---|
| 54321 | Supabase API gateway (Kong): Data API, Auth, `/functions/v1/*` |
| 54322 | PostgreSQL |
| 54320 | Shadow database used by `db pull`/`db diff` |
| 3000 | `npm run dev` (the Auth `site_url` and redirect `http://127.0.0.1:3000/auth/callback`) |
| 3100 | The repository Playwright configuration's dev server (`PLAYWRIGHT_DEV_PORT` moves it) |
| 4173 | `scripts/serve-static.mjs`, the repository's static export host (`CLOUDIATOR_STATIC_PORT`; `PLAYWRIGHT_STATIC_PORT` for the Playwright configuration) |
| 3200, 3300 | Private Playwright configurations of the `Cloudiator-claude` and `Cloudiator-replay` worktrees (`node_modules/.cache/`, not committed) |

### Worktrees

| Path | Branch (2026-10-19) | Use |
|---|---|---|
| `C:\Avi\Studies\Projects\Cloudiator` | `codex/gladiator-arena` | The main checkout and integration branch (pushed to `origin`) |
| `C:\Avi\Studies\Projects\Cloudiator-claude` | `claude/task-22` | Task 22 backend lane; currently serves the local Edge functions |
| `C:\Avi\Studies\Projects\Cloudiator-replay` | `claude/task-22-client` | Task 22.5 client lane |
| `C:\Avi\Studies\Projects\Cloudiator-arena` | `claude/preview` | Not part of Task 22 |

Every worktree has its own `node_modules` and `.next`, and may run unit tests, builds and browser checks in parallel on its own
ports. The Supabase stack is shared: only one worktree at a time runs database tests, and the Edge runtime serves the worktree
that last ran `supabase functions serve`. Follow `docs/operations/verification-gates.md` (record the Edge container's start
time around `npm run test:db`). `.backups/` (exports) is per worktree and git-ignored.

## Hosted environment (Task 24 placeholders)

Nothing is hosted yet. Task 24 fills these in; until then every value is unknown and nothing in the code assumes one.

| Item | Value |
|---|---|
| Supabase project ref and region | TBD (Task 24) |
| Data API URL | TBD (Task 24) |
| Static site host and exact origin(s) | TBD (Task 24); also `GAME_ALLOWED_ORIGINS` and the Auth redirect URLs |
| Google OAuth client | TBD (Task 24), configured in the hosted Auth provider settings |
| Database owner connection | Dashboard only; used through `CLOUDIATOR_DB_URL` / `CLOUDIATOR_EXPORT_DB_URL` in the operator's shell |
| `pg_net.ttl` | Check after deploying M16 (`docs/operations/migrations.md`, M16 release notes); 6 hours locally |
| Season epoch, scheduler | Set the epoch, then enable `private.scheduler` (M09 and M16 release notes) |
| Plan and budgets | Free tier: 250 MB database, 3 GB monthly egress, 300,000 monthly Edge Function invocations (runbook, "Budgets") |

## Environment variables and secrets

| Name | Kind | Used by | Where it lives |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public configuration | the browser bundle | the static build's environment (hosting build settings; locally the shell or Playwright config) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public key | the browser bundle | the static build's environment; a production build refuses the test-only value (`next.config.ts`) |
| `NEXT_PUBLIC_FIXTURE_ENABLED` | development flag | fixture mode | `.env.example` documents it; production builds always force it off |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | platform configuration | both Edge functions | injected by the platform (hosted) or by `supabase functions serve` (local) |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | both Edge functions | injected by the platform or the local CLI; never in the frontend (`scripts/verify-static.mjs` fails an export that contains a service-role, secret-key or worker-secret name or an `sb_secret_` key) |
| `GAME_ALLOWED_ORIGINS` | configuration | `game-command` | Edge function secrets (hosted); `.env.edge.local` (local, git-ignored) |
| `GAME_WORKER_SECRET` | **secret**, at least 32 characters | `game-worker` | Edge function secrets (hosted); `.env.edge.local` (local, git-ignored). Must equal Vault `game_worker_secret` |
| Vault `game_worker_url`, `game_worker_secret` | **secret** (database) | `private.dispatch_workers` | the hosted database's Vault only; unset locally. Never exported (runbook, "Weekly export") |
| `CLOUDIATOR_DB_URL` | **secret** (owner connection string) | `scripts/health.mjs` | the operator's shell, for one session |
| `CLOUDIATOR_EXPORT_DB_URL` | **secret** (owner connection string) | `scripts/export-db.ps1 -Remote` | the operator's shell, for one session |
| `NODE_EXTRA_CA_CERTS` | path | `scripts/health.mjs` with `sslmode=verify-full` | the operator's shell (runbook, "Connections and TLS") |
| `LOCAL_DB_TEST`, `LOCAL_API_URL`, `LOCAL_DB_URL`, `LOCAL_ANON_KEY`, `LOCAL_SERVICE_KEY`, `LOCAL_JWT_SECRET`, `LOCAL_WORKER_SECRET` | local test credentials | the database tests | set in memory by `scripts/test-db.mjs` from the local CLI and `.env.edge.local`; never set by hand |
| `CLOUDIATOR_BROWSER_TEST`, `PLAYWRIGHT_STATIC`, `PLAYWRIGHT_STATIC_ROOT`, `CLOUDIATOR_STATIC_ROOT` | test configuration | builds and browser tests | the command line (`docs/operations/verification-gates.md`) |
| `PLAYWRIGHT_DEV_PORT`, `PLAYWRIGHT_STATIC_PORT`, `CLOUDIATOR_STATIC_PORT` | test configuration | the repository Playwright configuration and `scripts/serve-static.mjs` | the command line, or `npm run verify -- --dev-port <n> --static-port <n>` (Task 23.6) |
| `CAPACITY_GATE` | test configuration | `tests/db/capacity.test.ts` enforces its budgets with `1` | set by `npm run verify` (Task 23.6) |
| `CLOUDIATOR_MEASUREMENTS` | test output switch | `1` prints the measurements the database and browser suites record (`tests/fixtures/measurements.ts`) | the command line; unset in the gate, whose output stays clean (Task 23.6, C23) |
| `PLAYWRIGHT_JSON_OUTPUT_NAME` | test configuration | where a browser step's JSON report goes | set by `npm run verify` to a temporary file |

In CI (`.github/workflows/checks.yml`, Task 23.6) the runner's local stack is started fresh and `.env.edge.local` gets a
`GAME_WORKER_SECRET` generated for that run, never printed; no hosted key or secret is used.

`.gitignore` ignores `.env*` (except `.env.example`), `*.pem`, `*.key`, `*.log`, `.supabase/`, `supabase/.temp/` and
`.backups/`. A new secret gets a row here (name, kind, user, where it lives) in the same change that introduces it.
