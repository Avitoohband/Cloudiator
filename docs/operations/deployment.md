# Deployment checklist

Task 24.2 (plan [`2026-10-20-task-24-launch.md`](../superpowers/plans/2026-10-20-task-24-launch.md), Decisions 2–8 and 13;
Avi accepted every recommended answer on 2026-10-20). This is the operator checklist for putting Cloudiator on a free
Cloudflare Pages origin backed by a free Supabase project and a Google OAuth client: first the rehearsal project
"cloudiator-bench", then production. Every step is marked with who runs it:
- **[Avi]**: Avi, by hand, in his own browser, dashboard or PowerShell window.
- **[Claude after Avi's go]**: Claude, only after Avi has said "go" for that command on that project.
- **[Claude]**: Claude, credential-free (local work, reading files Avi saved, probes against public URLs).

Nothing here has run against a hosted project yet. Dashboard labels are written as of October 2026 and can move; when a
label differs, follow the setting's meaning and tell Claude, who corrects this file. Long procedures live in the
[runbook](runbook.md) and are linked, not repeated. Environment names are in [environment.md](environment.md).

## Placeholders

This file holds no real value. Every `<…>` is filled in at the time, in chat, with the names and public identifiers listed
under "What Avi may paste". Claude records them (names only) in `environment.md` (plan Task 24.3).

| Placeholder | Meaning |
|---|---|
| `<ref>` | The Supabase project ref of the project being worked on: `<bench-ref>` in the bench run, `<prod-ref>` in the production run. A public identifier (it is in every API URL), not a secret. |
| `<project-url>` | `https://<ref>.supabase.co`, no trailing slash. |
| `<pages-project>` | The Pages project name: `cloudiator`, fallback `cloudiator-arena` (plan question 4). |
| `<pages-origin>` | The production origin, `https://<pages-project>.pages.dev`, exactly as the Pages dashboard shows it. |
| `<bench-origin>` | The bench branch alias, `https://bench.<pages-project>.pages.dev`. Per-commit preview URLs (`https://<hash>.<pages-project>.pages.dev`) are never allowed anywhere. |
| `<origin>` | The site origin of the project being worked on: `<bench-origin>` or `<pages-origin>`. An exact origin: scheme and host, no path, no trailing slash. |
| `<deploy-commit>` | The reviewed commit being deployed (full SHA). |
| `<release-base>` | The first commit `release` points at (Part 1). |
| `<private folder>` | Avi's encrypted folder outside every repository (plan question 12). |
| `<work>` | A new temporary folder outside the repository for one comparison run; Claude creates it and names it. |
| `<N>` | The season epoch slot, computed by Claude at activation. |

## Roles and safety rules

- **Avi does every account, sign-in, secret and dashboard step** (plan Lane H, Decision 6): creating accounts and projects,
  `supabase login` and `link`, anything that prompts for or holds a secret, `secrets set`, the SQL editor,
  `npm run health -- --remote`, `scripts/export-db.ps1 -Remote`, and every dashboard setting.
- **Claude never sees, types or stores** a key (the publishable key included), password, token, connection string, client
  secret, Vault value or email address. Claude prepares the exact steps and commands, runs the credential-free ones, and
  reads only what Avi pastes or saves under the rules below.
- **Claude's hosted commands** are `db push --dry-run`, `db push`, `migration list --linked`, `functions deploy`, and the git
  pushes of `release` and `bench`, each run from `C:\Avi\Studies\Projects\Cloudiator-claude` (an LF working copy) only after
  Avi's "go" for that command on that project. Before asking, Claude states the command, the project name and ref, and the
  commit. A "go" covers one command once. If any command Claude runs asks for a password or token, Claude stops it and hands
  the step to Avi.
- **No paid upgrade, ever** (Global Constraints). Never choose a paid plan or add-on: no Supabase Pro, compute size, IPv4
  add-on, point-in-time recovery or custom domain; no Cloudflare Workers Paid; no billing account on the Google Cloud project.
  If a screen offers one as the way forward, stop and tell Claude.
- **Never run** `supabase config push` (it would overwrite the hosted Auth settings with the local `127.0.0.1` ones),
  `db reset --linked` (except Decision 4's fallback, below), `supabase status`, or any CLI flag that carries a credential
  (`--db-url`, `-p`/`--password`, `--token`). Never type a connection string on a command line: use the runbook's
  [secure prompt](runbook.md#entering-a-connection-string).
- **Soft launch** (Decision 7): the production URL stays unannounced until Part 3 passes. Test characters are real and
  permanent.
- **Evidence:** Claude records each step's sanitized results in `release-evidence.md` and commits them with the plan's commit
  messages (24.3–24.12). Hosted steps commit sanitized evidence only.

### What Avi may paste

| May paste or save for Claude | Never paste, save or show |
|---|---|
| Project names and refs, the region, the Postgres version | Any key: publishable, anon, service_role, secret, JWT secret |
| The Pages project name and the origins | Passwords, including the database password; connection strings (direct or pooler) |
| Yes/no answers, counts, status words (`success`, `failed`), setting names, lint names | Tokens: the CLI access token, JWTs, any URL holding `code=`, `access_token` or `error_description` |
| The CSV results of `scripts/access-audit.sql`, `scripts/schema-fingerprint.sql` and `scripts/hosted-checks.sql`, saved into `<work>` | The Google client ID and client secret; any email address |
| `npm run health` exit code and JSON; `private.cleanup_tick()`'s result; the restore check's summary fields | The Edge env file, Vault values, `secrets list` digests, psql error text that quotes rows |
| A failed build's step name and its last error line | Screenshots that show any of the above (crop them first) |

The three SQL kits are read-only and print no secret, key, token or email by design (each file's header); the health report
holds only counts, slots, codes and job ids. If anything else appears (a stack trace, a host name, a connection string),
paste only the exit code and say what kind of text appeared.

### Stop rules

Stop, change nothing more, and tell Claude when:
- a dry run lists anything other than the expected migrations;
- a parity comparison differs outside the platform sections, or any finding row appears;
- a probe shows `Access-Control-Allow-Origin: *`, or a disallowed origin is granted;
- a Pages build fails for a reason other than the one this checklist expects;
- an activation statement returns no row or fails;
- the health check reports an alert after the first boundary, or exits `2`;
- any screen asks for a paid plan, a billing account or Google verification.

## Part 1: one-time accounts

### Supabase organization

1. **[Avi]** Sign in to Supabase and use one organization on the **Free** plan (create it if needed; no payment method).
2. **[Avi]** Check that both older Supabase projects are paused: the free plan allows two active projects, and the bench
   and production need both. **Paste:** `older projects paused: 2 of 2`.
   - If one cannot be paused, use Decision 4's fallback: skip the bench, run Part 2 on production up to (not including)
     activation as the rehearsal, and Avi runs `npx supabase db reset --linked` on it before the real run, while it has no
     players. Claude rewrites the bench-only steps for that case first.
3. **[Avi]** In his own PowerShell window, in `C:\Avi\Studies\Projects\Cloudiator-claude`: `npx supabase login` (the
   browser flow; never `--token`). The CLI keeps its access
   token in Avi's profile; Claude's CLI calls use it without ever reading it. **Paste:** `logged in: yes`.

### Google Cloud project and consent screen

1. **[Avi]** In the Google Cloud console, create a project (for example "Cloudiator"). Do not link a billing account.
2. **[Avi]** Google Auth Platform (or "OAuth consent screen"):
   - **Branding:** app name `Cloudiator`, Avi's support and developer contact emails (never pasted), no logo (a logo triggers
     Google's brand verification). Add the authorized domain `<pages-project>.pages.dev`; the per-project
     `<ref>.supabase.co` domains are added in Part 2.
   - **Audience:** External, then **Publish app** so the status reads **In production** (plan question 9). A consent screen
     left in "Testing" refuses every account not on its test list.
   - **Data access:** exactly `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. No other scope.
3. **Paste:** `consent screen: External, In production, 3 identity scopes, no logo: yes`.

The OAuth clients are made per Supabase project in Part 2: one for the bench (deleted with it) and one for production, so
the bench never shares production's client secret.

### Cloudflare account and the Pages project

The Pages project is shared: its production branch `release` serves `<pages-origin>`, and its only preview branch `bench`
serves `<bench-origin>` (Decision 3). It is created now, with no build variables, to reserve the origin before the Auth
settings name it.

1. **[Claude after Avi's go]** Create `release` on GitHub at `<release-base>`, the integrated and pushed commit on
   `codex/gladiator-arena` that contains Task 24.1's build-environment refusal (`e511c3c` or a later reviewed commit):
   ```powershell
   git -C C:\Avi\Studies\Projects\Cloudiator-claude merge-base --is-ancestor e511c3c <release-base>; "contains 24.1: $?"
   git -C C:\Avi\Studies\Projects\Cloudiator-claude push origin <release-base>:refs/heads/release
   ```
   With no build variables, `npm run build` then fails in `scripts/build-headers.mjs` ("NEXT_PUBLIC_SUPABASE_URL is not
   set"), so the first automatic build serves nothing. An older commit would build and serve a site with no backend.
   Claude pushes nothing else to `origin` until Avi confirms step 4.
2. **[Avi]** Create a free Cloudflare account (or sign in).
3. **[Avi]** Workers & Pages → Create → Pages → Connect to Git → GitHub. Install the Cloudflare Pages app for **only** the
   repository `Avitoohband/Cloudiator`. Then:
   - project name `cloudiator` (if the origin it shows is not `https://cloudiator.pages.dev`, use `cloudiator-arena`);
   - production branch `release`;
   - framework preset None, build command `npm run build && npm run verify:static -- --origin "$NEXT_PUBLIC_SUPABASE_URL"` (the deploy build fails unless the static scan finds no forbidden material and `_headers` names exactly that project; Decision 12), build output directory `out`, root directory empty;
   - no environment variables.
   Save and deploy. The first build is expected to **fail** at `scripts/build-headers.mjs`.
4. **[Avi]** Settings → Builds (Builds & deployments) → Branch control: production branch `release` with automatic
   deployments on; preview branches **Custom**, include only `bench`.
5. **Paste:** `pages origin: <pages-origin>`, `first build failed at build-headers: yes`,
   `previews: bench only: yes`.

**[Claude]** Records `<pages-origin>` and `<bench-origin>`; commits `ops: record the hosted environment` with the names known
so far (Task 24.3).

## Part 2: per project

Run all of Part 2 for the bench first, then again for production. Production is created only after the bench is seeded
(Decision 4): that order is also what keeps `bench-seed.sql` away from an empty production database, which it could not tell
apart from the bench.

| | Bench (first) | Production (second) |
|---|---|---|
| Supabase project name | `cloudiator-bench` | `cloudiator` |
| `<ref>` | `<bench-ref>` | `<prod-ref>` |
| `<origin>` (Site URL, `GAME_ALLOWED_ORIGINS`, Google JavaScript origin) | `<bench-origin>` | `<pages-origin>` |
| Redirect allow-list | `<bench-origin>/auth/callback/` | `<pages-origin>/auth/callback/` |
| Google OAuth client | "Cloudiator bench" | "Cloudiator" |
| Edge env file | `<private folder>\bench-edge.env` | `<private folder>\production-edge.env` |
| Pages variables | the **Preview** environment | the **Production** environment |
| Client step | push `bench` | fast-forward `release` |
| Before activation | `bench-seed.sql`, 50 characters | nothing: no sign-in, no character |
| Epoch guard | the seeded characters' first boundary | no gladiator exists |

**Before starting, [Claude]:** `<deploy-commit>` is reviewed, passed the gate of record (`npm run verify`, 12/12, run with
nothing else active), and is pushed to `origin/codex/gladiator-arena`. The deployed harness (Task 24.2) is committed. For the
bench, `scripts/bench-seed.mjs` (Decision 4) is built and reviewed.

### Create the project

1. **[Avi]** New project in the Free organization: name from the table; region **Central EU (Frankfurt), `eu-central-1`**;
   a generated database password, kept only in Avi's password manager. If the form offers Data API options, keep the Data
   API on with the `public` schema.
2. **[Avi]** Once it is ready, check:
   - Settings → Infrastructure: PostgreSQL **17** (M17 needs MAINTAIN; Decision 5).
   - Settings → API Keys: a publishable key (`sb_publishable_…`) exists, and the **legacy** `anon` and `service_role` keys
     exist and are enabled (the Edge functions read `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`).
   - Settings → JWT Keys: the current signing key's **type name** (for example "Legacy HS256 (shared secret)" or "ECC
     (P-256)"); Claude needs it for Decision 9.
3. **Paste:** `project: <name>, ref <ref>, region eu-central-1, Postgres 17: yes, legacy anon and service_role enabled: yes,
   signing key type: <type name>`.

### Data API

1. **[Avi]** Settings → Data API (or Integrations → Data API), matching `supabase/config.toml` `[api]`:
   - exposed schemas: **`public` only** (remove `graphql_public`; `private` is never exposed);
   - extra search path: `public, extensions` (the default);
   - max rows: **50**;
   - if a setting offers to expose new tables automatically, turn it off (`auto_expose_new_tables = false` locally). The
     access audit below is the proof either way.
2. **Paste:** `exposed schemas: public; max rows: 50`.

### Auth

1. **[Avi]** Authentication → Sign In / Providers:
   - new user sign-ups **allowed** (a first Google sign-in creates the account);
   - **Email** provider off, **Phone** off, **anonymous sign-ins** off, CAPTCHA off.
2. **[Avi]** Authentication → URL Configuration:
   - Site URL: `<origin>`;
   - redirect URLs: exactly one entry, `<origin>/auth/callback/`, **with the trailing slash**, no wildcard and no localhost.
     `src/lib/api/client.ts` sends `${origin}/auth/callback/`; a list without that exact entry falls back to the Site URL and
     the sign-in never completes.
3. **[Avi]** JWT expiry (Settings → JWT Keys, "access token expiry"): **3600** seconds.
4. **[Avi]** Open the Google provider panel (do not enable it yet) and note its **Callback URL**: it must read
   `<project-url>/auth/v1/callback`.
5. **Paste:** `auth: Google pending, email/phone/anonymous off, site URL <origin>, redirect <origin>/auth/callback/,
   JWT expiry 3600, callback <project-url>/auth/v1/callback`.

### Google OAuth client

1. **[Avi]** Google Auth Platform → Branding: add the authorized domain `<ref>.supabase.co`.
2. **[Avi]** Clients → Create client → Web application, named from the table:
   - authorized JavaScript origin: `<origin>`;
   - authorized redirect URI: `<project-url>/auth/v1/callback` (the Supabase callback from Auth step 4, not the app's
     `/auth/callback/`).
3. **[Avi]** Copy the client ID and the client secret straight into the Supabase Google provider panel, enable Google, save.
   Do not download the client JSON or keep the secret anywhere else. If the secret is lost, add a new one in Google and
   replace it in Supabase.
4. **Paste:** `google client <name> created; origin and redirect set; Supabase Google provider enabled: yes`.

### Line endings and link

1. **[Claude]** In `C:\Avi\Studies\Projects\Cloudiator-claude`, at `<deploy-commit>`
   ([migrations.md, "Fresh checkout"](migrations.md#fresh-checkout)):
   ```powershell
   git status --short                                                    # must print nothing
   git rev-parse HEAD                                                    # must print <deploy-commit>
   git ls-files --eol | Where-Object { $_ -notmatch '^\S+\s+w/(lf|-text)\s' }   # must print nothing
   ```
   A CRLF working copy stores CRLF in every function body, and the hosted bodies would then not match the fingerprint.
2. **[Avi]** In his own PowerShell window, in that folder: `npx supabase link --project-ref <ref>`. If it asks for the
   database password, type it at the prompt only. **Paste:** `linked <ref>: yes`.
3. **[Claude]** Before every hosted command in this part, confirm the linked project:
   `Get-Content -LiteralPath supabase\.temp\project-ref` must print `<ref>`. Read no other file in `supabase\.temp` (one
   holds a pooler connection string). If the file is absent in this CLI version, ask Avi which project is linked.

### Migrations

1. **[Claude after Avi's go]** `npx supabase db push --help`, then `npx supabase db push --dry-run`. On a new project it must
   list exactly the 22 committed migrations, M01 `20261012050952_identity` to M22 `20261020075858_idle_rest`.
2. **[Claude after Avi's go]** `npx supabase db push --yes` (all of M01–M22 in one push; Decision 2). Never with
   `--include-all`, `--include-seed`, `--include-roles`, `--db-url` or `--password`.
   - If it fails, stop. Claude reads the CLI's error (it names a statement, not a secret) and decides with Avi before any
     retry. A failure only the hosted, non-superuser `postgres` hits (for example M01's
     `ALTER PUBLICATION supabase_realtime OWNER`) is exactly what the bench run is for. Committed migrations are never
     edited.
3. **[Claude after Avi's go]** `npx supabase migration list --linked`: the local and remote columns list the same 22
   versions.

### Parity

The three kits are one read-only SELECT each. Avi copies a file into the SQL editor without opening it, for example
`Get-Content scripts\hosted-checks.sql -Raw | Set-Clipboard`, runs it in a new query with no row limit, and downloads the
result as CSV.

1. **[Claude]** Make the local references at `<deploy-commit>`: after the container label check, a clean
   `npx supabase db reset --local --no-seed --yes` (it deletes local data; no other lane may be using the stack), then the
   fingerprint, the access audit and the hosted checks through the local container with `--csv`, into `<work>`
   ([runbook, "Release access audit"](runbook.md#release-access-audit) steps 1 and 2;
   [runbook, "Schema fingerprint and hosted checks"](runbook.md#schema-fingerprint-and-hosted-checks)). Claude tells Avi the
   `<work>` path.
2. **[Avi]** In the SQL editor, with the project selector showing this project's name:
   - `select current_schemas(false);` **Paste** the result (expected `{public,extensions}`, the same as locally).
   - Production's bench marker needs no query of its own: the `bench marker` row of `scripts/hosted-checks.sql`'s `parity` section (the third file below) must read `absent`, and Claude checks it in step 3. Fallback, only if that kit cannot run on production (Task 24.2c): `select shobj_description((select oid from pg_database where datname = current_database()), 'pg_database') as comment, to_regnamespace('cloudiator_bench_marker') as marker;` **Paste** both values: production must show neither `cloudiator-bench` nor a marker schema.
   - Run `scripts/schema-fingerprint.sql`; save as `<work>\hosted-schema-fingerprint.csv`.
   - Run `scripts/access-audit.sql`; save as `<work>\hosted-access-audit.csv`.
   - Run `scripts/hosted-checks.sql`; save as `<work>\hosted-checks.csv`.
   - If a kit fails, paste only the error's first line (it names an object, never data). The hosted owner's privileges on
     `vault.secrets`, `auth.users`, `auth.identities`, `net._http_response` and `cron.job` are untested.
   **Paste:** `saved 3 files in <work>`.
3. **[Claude]** Compare, as sets of lines:
   - fingerprint: identical, except `defacl` lines that are the platform's own entries;
   - access audit: the runbook's steps 4–6; only `platform-default` and `database` rows may differ, and no finding row may
     appear on either side;
   - hosted checks, `parity`: migrations count 22, last `20261020075858`, server version 17, the same search-path schemas,
     0 triggers disabled, a functions digest equal to the local one, and `bench marker` `absent` (the bench is marked only
     later, in its seeding step, so this holds on both projects; on production it must hold for good, and anything else
     stops the run);
   - hosted checks, `scheduler`: scheduler `false`, epoch `unset`, both cron jobs (`cloudiator-coordinate` `* * * * *`,
     `cloudiator-cleanup` `23 * * * *`) `active=true`, both Vault names `missing` (they come later).
   - `pg_net.ttl`: if it reads `absent`, Claude adds the guarded `net._http_response` delete as a new reviewed migration
     (M23), and this project runs Migrations and Parity again before activation.
4. **[Avi]** Advisors → Security Advisor. **Paste:** the counts per level and the names of any WARN or ERROR lints. Any WARN
   or ERROR stops the run: Claude triages it (a schema finding needs a new migration; a platform or paid-only setting is
   recorded, never fixed by an upgrade).
5. **[Claude]** Records both row counts and every difference line; removes `<work>`. Commit
   `ops: verify the hosted schema and access` (24.4).

### Edge secrets

1. **[Claude]** Set the allowed origin (configuration, not a secret): the exact `<origin>`, one origin, no trailing slash
   (`game-command` refuses to start on anything that is not an exact origin):
   `npx supabase secrets set GAME_ALLOWED_ORIGINS=<origin> --project-ref <ref>`.
2. **[Avi]** From the worktree linked to `<ref>`, with the scheduler off: `node scripts/set-worker-secret.mjs --project-ref <ref>`.
   It generates the worker secret and sets the same value as the Edge secret `GAME_WORKER_SECRET` and the Vault secrets
   `game_worker_url` and `game_worker_secret` (see "Vault secrets" below). The value is never displayed and its private
   temporary folder is deleted afterwards. **Paste:** the `ok`/`failed` lines.
3. **[Claude]** `npx supabase secrets list --project-ref <ref>`, names only: `GAME_ALLOWED_ORIGINS`, `GAME_WORKER_SECRET`
   and the platform's `SUPABASE_*` names. Never the digest column.

### Deploy the functions

1. **[Claude after Avi's go]** From the LF working copy at `<deploy-commit>`, after the linked-ref check:
   ```powershell
   npx supabase functions deploy --help
   npx supabase functions deploy game-worker --project-ref <ref>
   npx supabase functions deploy game-command --project-ref <ref>
   ```
   `verify_jwt` comes from `supabase/config.toml`: `false` for `game-worker` (its secret is the authorization) and, since
   Decision 9 on 2026-10-23 (the bench signs user tokens with an ECC P-256 key), `false` for `game-command` too (its handler
   verifies every caller through Auth). Never pass `--no-verify-jwt` by hand. If `--help` offers a choice of bundler,
   use the one the bench proved and record it. A bundling failure shows here first, on the bench.

### Probes

**[Claude]** Credential-free, against the public function URLs (`curl.exe`, not PowerShell's `curl` alias):
```powershell
$fn = '<project-url>/functions/v1'
# Preflight from the exact origin: 204, Access-Control-Allow-Origin exactly <origin>, Access-Control-Max-Age 7200.
curl.exe -s -o NUL -D - -X OPTIONS -H 'Origin: <origin>' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization, apikey, content-type, x-client-info' "$fn/game-command"
# Another origin: 403 and no Access-Control-Allow-Origin.
curl.exe -s -o NUL -D - -X OPTIONS -H 'Origin: https://example.invalid' -H 'Access-Control-Request-Method: POST' "$fn/game-command"
# The worker without its secret: 401 and {"ok":false,"code":"unauthenticated"}.
curl.exe -s -i -X POST "$fn/game-worker"
```
- `Access-Control-Allow-Origin: *` anywhere stops the run (migrations.md, "CORS and hosting follow-up").
- A preflight refused by the gateway (401 before the handler), or a signing key type other than the legacy shared secret,
  triggers Decision 9 (question 17, approved): Claude sets `verify_jwt = false` for `game-command` in a reviewed commit,
  tells Avi, redeploys `game-command` after Avi's go, and probes again. The handler already verifies the Google user.
- A 5xx from a function means it did not start (a missing or malformed secret, or missing legacy keys): check the Edge secrets
  and the project's legacy keys.
- Commit `ops: verify hosted CORS and the worker boundary` (24.5) after the Edge secrets step.

### Vault secrets

Set by `scripts/set-worker-secret.mjs` in the Edge secrets step. It creates each name when absent (a new or restored database
has no row, and `vault.update_secret` alone would change nothing without an error) and updates it when present. It sends one
SELECT, so the query statistics store its values as placeholders, and its last line confirms both names are present. If any
line reads `failed`, keep the scheduler off and rerun the script. The manual fallback is in the
[runbook, "Secret rotation"](runbook.md#secret-rotation).

### Pages variables

1. **[Avi]** Pages project → Settings → Variables and Secrets, in the environment from the table (Preview for the bench,
   Production for production), type text (they are public values that ship in the bundle):
   - `NEXT_PUBLIC_SUPABASE_URL` = `<project-url>`;
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = this project's `sb_publishable_…` key. Never the legacy `anon` JWT: the client
     refuses any key without that prefix, and the release scan fails an export that carries a JWT;
   - `NODE_VERSION` = `22.19.0`.
2. **Paste:** `<environment> variables set: 3 names; key starts with sb_publishable_: yes`.

### The client

Deploy the client only after M18, M22 and both functions (Decision 2; migrations.md M18 and M22 notes).

1. **[Claude]** A local check of the same commit with the project's URL (no key needed; follow
   [verification-gates.md](verification-gates.md): no browser run in this worktree at the same time):
   ```powershell
   $env:NEXT_PUBLIC_SUPABASE_URL = '<project-url>'
   npm run build
   npm run verify:static -- --origin <project-url>
   Remove-Item Env:NEXT_PUBLIC_SUPABASE_URL
   ```
2. **[Claude after Avi's go]** Bench: `git push origin <deploy-commit>:refs/heads/bench`. Production: first
   `git merge-base --is-ancestor origin/release <deploy-commit>` (must succeed), then
   `git push origin <deploy-commit>:refs/heads/release`. Never with `--force`.
3. **[Avi]** Watch the Pages build (the first one installs the `supabase` and `deno` dev dependencies; their downloads are the
   likeliest failure). **Paste:** `build <success|failed>`, and on failure the failing step's name and last error line.
4. **[Claude]** Run the deployed harness (Task 24.2, `tests/browser/deployed.spec.ts` with
   `tests/browser/playwright.deployed.config.ts`, `<harness settings>` for `<origin>` and `<project-url>`). Its automatic
   checks must pass: `fixedRoutesReload`, `securityHeaders`, `connectSrc` (exactly `<project-url>`), `compression`
   (`br` or `gzip` for JavaScript and Data API responses), `cors`, `anonDenied`, `authProvidersGoogleOnly` and
   `shippedAssetsClean`. Production: commit `ops: verify the deployed static origin` (24.6).
5. Production: nobody signs in or creates a character until Activation is done (its epoch guard requires no gladiator).

### Bench only: the seed

No Google sign-in on the bench before this step: the seed refuses a database that already has users or gladiators.

1. **[Avi]** Mark the bench, as its own statement, in the SQL editor with the project selector showing **cloudiator-bench**:
   `comment on database postgres is 'cloudiator-bench';` (if the owner may not comment on the database, run
   `create schema cloudiator_bench_marker;` instead). **Paste:** `bench marked: yes` and which marker. The seed refuses any
   database without one of these markers, so it can never run on production; production must never carry either marker.
2. **[Claude]** `node scripts/bench-seed.mjs` writes `bench-seed.sql` (Decision 4: 50 all-expedition characters,
   credential-free owner SQL). Claude tells Avi its path.
3. **[Avi]** In the SQL editor, still on **cloudiator-bench**, run the whole file. **Paste:** its result: the counts, the
   seeding slot and `first_member_boundary`.
4. **Activate the bench in the same 80-minute slot when possible** (Activation below): its epoch must be at most
   `first_member_boundary`, and a later activation makes the coordinator replay every boundary since the seeding. Run the bench
   benchmarks (24.9, 24.11) within 14 days of the seeding slot, before the synthetic owners count as idle.
5. Production is created only after this step (Decision 4).

### Activation

Order (Decision 2, migrations.md M09 and M16 notes): the epoch, then the scheduler, then one cleanup tick. The Vault secrets
must already exist: a scheduler without them dispatches nothing (`unconfigured`), and a missing or late epoch stalls every
boundary with members (`wait: 'epoch'`). Slots are 80 minutes (4,800,000 ms) counted from the Unix epoch.

1. **[Avi]** Run `scripts/hosted-checks.sql` and paste the `scheduler` section rows (the database clock's current and next
   slot, the epoch `unset`, `characters minProcessedSlot`: `null` on production, the seeded slot on the bench).
2. **[Claude]** Computes `<N>` = the current slot + 1 (the next full slot) and cross-checks the local clock:
   ```powershell
   node -e "const now = Date.now(), next = Math.floor(now / 4800000) + 1; console.log(JSON.stringify({ next, startsUtc: new Date(next * 4800000).toISOString(), minutesLeft: Math.floor((next * 4800000 - now) / 60000) }))"
   ```
   With fewer than 15 minutes left in the slot, Claude waits for the next one. Claude then sends Avi the statements below with
   `<N>` filled in.
3. **[Avi]** In the SQL editor. Production (no gladiator may exist):
   ```sql
   insert into private.season_epoch(epoch_slot)
   select <N> where private.planning_now_ms() / 4800000 = <N> - 1 and not exists (select 1 from public.gladiators)
   returning epoch_slot;
   ```
   Bench: `<N>` is the seed output's `first_member_boundary` (not the next full slot; it may already have passed if the
   bench is activated after the seeding slot — the epoch must not be later than the seeded characters' first boundary, or
   the bench stalls for good):
   ```sql
   insert into private.season_epoch(epoch_slot)
   select <N> where (select min(processed_slot_index) from public.gladiators) + 1 = <N>
   returning epoch_slot;
   ```
   It must return one row, `<N>`. No row means the slot changed or the guard failed: stop and ask Claude. The row is
   immutable; never insert a second one.
4. **[Avi]** The scheduler, only with the epoch and both Vault secrets present:
   ```sql
   update private.scheduler set enabled = true
   where singleton and exists (select 1 from private.season_epoch where singleton)
     and (select count(*) from vault.secrets where name in ('game_worker_url', 'game_worker_secret')) = 2
   returning enabled;
   ```
   It must return `true`. If it fails because the owner cannot read `vault.secrets`, stop: after Avi confirms both names in
   Integrations → Vault, Claude sends a variant without that condition.
5. **[Avi]** `select private.cleanup_tick();` once (otherwise `cleanup-stale` stays on until minute 23). **Paste:** the
   returned epoch, `enabled true`, and the cleanup result.
6. **[Avi]** Run `scripts/hosted-checks.sql` again. **Paste:** the `scheduler` section (epoch `<N>`, scheduler `true`, both
   Vault names `present`).
7. Production: from now on the game is live (soft launch). Commit `ops: activate the season epoch and scheduler` (24.7).

### Health check

The first boundary is at the start of slot `<N>`. Claude never waits silently for it: Claude asks Avi for an approved
follow-up at that time plus 5 minutes, and claims nothing before it.

1. **[Avi]** Once: Database settings → SSL configuration → download the CA certificate to
   `<private folder>\<ref>-ca.crt` (Decision 13).
2. **[Avi]** In his own PowerShell window, in the repository
   ([runbook, "Health check"](runbook.md#health-check) and ["Connections and TLS"](runbook.md#connections-and-tls)):
   ```powershell
   $env:NODE_EXTRA_CA_CERTS = '<private folder>\<ref>-ca.crt'
   # Set CLOUDIATOR_DB_URL at the secure prompt of runbook "Entering a connection string" (the owner string), then:
   $env:CLOUDIATOR_DB_URL = $env:CLOUDIATOR_DB_URL + '?sslmode=verify-full'
   npm run health -- --remote
   "exit $LASTEXITCODE"
   Remove-Item Env:CLOUDIATOR_DB_URL, Env:NODE_EXTRA_CA_CERTS
   ```
   If the direct string gives `connection-failed`, use the session-pooler string (port 5432, user `postgres.<ref>`). If
   `verify-full` fails on the pooler, stop and tell Claude; never fall back to `require` silently.
3. **Paste:** the exit line and the JSON. Expected: exit `0`, no alerts, `slotsBehind` 0, `scheduler.enabled` true, and an
   `operational.cronRunDetails` entry that is not `{ok:false}` (the `cron.job_run_details` privilege; Task 22's handoff).

The bench is now ready for 24.9 and 24.11; continue with Part 2 for production. After production, continue with Part 3.

## Part 3: the real journey and measurements

On production unless marked bench. Avi uses his own desktop browser and phone (Decision 8: Google often refuses automated
browsers); the harness covers every credential-free check.

### Real journey (24.8)

1. **[Avi]** Desktop, account A: open `<pages-origin>`, sign in with Google. The consent screen names `<prod-ref>.supabase.co`
   (expected: a custom domain is paid). Back on `/game/`, create a gladiator. Reload `/game/`: the same gladiator, still signed
   in. Open `<pages-origin>/auth/callback/` directly: the app's own page, no host 404.
2. **[Avi]** Schedule edit: change one part of the day, save, reload: the change persists.
3. **[Avi]** Phone, account A: sign in, reload `/game/`: the same gladiator, no second one.
4. **[Avi]** Account B (a Google account Avi owns), in a private window: sign in, create a gladiator, buy an item from an NPC
   shop, list it on the Marketplace at a price P. Account A buys it. **Paste:** P (a game number).
5. **[Claude]** Computes the next boundary from the `scheduler` rows and asks for an approved follow-up at its start plus 5
   minutes.
6. **[Avi]** At the follow-up, run `scripts/hosted-checks.sql`. **Paste:** the `characters`, `duplicate-grants`, `trades` and
   `boundary-latency` sections. Expected: 2 accounts, 2 accounts with a character, 0 with more than one, identities from
   `google` only; `duplicateGrants`
   total 0; 1 sale with the price paid and the fee right (the seller receives P minus 5 % floored) and its item owned once,
   by the buyer; the boundary published within 120 s.
7. **[Claude]** Records the attested values (`persistedCharactersForNewGoogleAccount` = 1,
   `completedRealBoundary.duplicateGrants` = 0, `twoAccountTrade {owners: 1, feeCorrect}`). Commit
   `test: record the deployed journey`.

### Hosted capacity (24.9)

1. **[Avi]** After at least one day with the scheduler on, run `scripts/hosted-checks.sql`. **Paste:** the `dispatch`,
   `job-attempts`, `boundary-latency` and `http-responses` sections. Expected (C4): at most 5 dispatches in any scheduled
   minute (0 minutes over the budget); p95 per job kind recorded; 0 boundaries over 120 s.
2. **[Avi]** Edge Functions → `game-worker` → logs for the same day. **Paste:** the count of CPU-limit or status-546
   failures (counts only, no log lines).
3. **Bench [Avi]:** after several boundaries with the 50 seeded all-expedition characters at production cadence, the same
   `boundary-latency` section from the bench. Each boundary must publish within 120 s.
4. **Egress [Avi + Claude]:** Avi reads the organization usage page (egress and Edge Function invocations for the cycle) and
   pastes the numbers with the time; Claude runs a controlled set of N visitor reads against `<pages-origin>`; when the usage
   page covers the run, Avi pastes the numbers again, with the per-service breakdown's names and values. Claude settles from
   the documentation and that breakdown whether Edge-to-API traffic is billed.
5. **[Claude]** Projects each budget for a month (3 GB egress, 300,000 invocations, 500 MB database). Over 80 % is a named
   risk; over 100 % goes to Avi. Revisits C6. Commit `test: measure the hosted budgets`.

### Recovery (24.10)

1. **[Claude]** The local `-Remote` rehearsal through `host.docker.internal:54322` with `sslmode=disable` (local stack only).
2. **[Claude]** Keeps the local stack running (the export's `pg_dump` runs in the local container) and copies the CA Avi saved
   into the container as [runbook, "Connections and TLS"](runbook.md#connections-and-tls) describes (a CA certificate is
   public).
3. **[Avi]** The hosted export, with `CLOUDIATOR_EXPORT_DB_URL` set at the secure prompt plus `?sslmode=verify-full` (session
   pooler as the fallback), written outside the repository
   ([runbook, "Export"](runbook.md#export)):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-db.ps1 -Remote -OutDir '<private folder>\backups'
   "exit $LASTEXITCODE"
   Remove-Item Env:CLOUDIATOR_EXPORT_DB_URL
   ```
4. **[Avi]** The restore check on that backup ([runbook, "Restore check"](runbook.md#restore-check)):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-check.ps1 -Backup '<private folder>\backups\<stamp>'`.
   **Paste:** both exit codes, the stamp, `duplicateGrants`, `lostItems`, `resume.status` (must be `replayed`) and the number
   of mismatches. Never psql error text: it can quote `auth.users` rows.
5. **Bench: the disaster-restore rehearsal** ([runbook, "Hosted restore"](runbook.md#hosted-restore)), on the bench's own
   export from steps 3 and 4 (its restore check passed). The reset replaces the bench's data with the backup's, so the bench
   measurements (24.9, 24.11) may run before or after it. **Never reset a project that is not the bench:** run step b while
   this folder is linked to the bench, before production's link (Part 2 for production); after that, only from a separate
   worktree linked to the bench alone.
   1. **[Claude]** Pauses the bench scheduler (`db query --linked --project-ref <bench-ref>`, runbook "Pausing and resuming
      the scheduler").
   2. **[Avi]** In his own PowerShell window, in that folder: `Get-Content -LiteralPath supabase.tempproject-ref` must
      print `<bench-ref>`; then `npx supabase db reset --linked --no-seed` (the database password at the prompt only).
      **Paste:** `bench reset: yes` and the CLI's last line.
   3. **[Claude]** Deletes both Vault secrets on the bench, so the restore creates them as on a new project (never
      `update_secret`): `delete from vault.secrets where name in ('game_worker_url', 'game_worker_secret');`, then reads
      `scripts/restore-hosted-facts.sql` there: 22 migrations, 0 accounts, 0 characters, no epoch, the scheduler off. If
      accounts remain after the reset, Claude stops and decides with Avi.
   4. **[Avi]** The data, runbook "Hosted restore" step 2, with the bench's connection string. **Paste:** the exit line,
      `ok`, `counts`, `mismatches` and `leftOut.entries`.
   5. **[Claude]** `node scripts/set-worker-secret.mjs --project-ref <bench-ref>` (it creates both Vault names), the
      scheduler with the Activation step 4 guard, `select private.cleanup_tick();`, then `scripts/hosted-checks.sql` and
      the health report until `slotsBehind` is `0`: `duplicateGrants` 0 and the same 50 bench characters.
   Commit `ops: rehearse the hosted export and restore`.

### Mobile frame rate (24.11)

1. **[Avi]** On the phone (**Paste:** its model), open `<bench-origin>/game/?perf=1` (the 50-actor world), then
   `<pages-origin>/game/?perf=1`.
2. **[Avi]** The fixed path on each: 30 s each of overview, pan and maximum zoom; a replay 5 times; an expedition 5 times;
   then the camp. One screenshot of the overlay per phase.
   Reading the overlay: the phase lines restart at camp-ready and at each scene open or close; read each phase from its own
   line. The `10 s:` line is a rolling window, so just after a scene change it still holds the previous phase's frames and the
   scene's start hitch; a low `10 s:` value right after a change is expected. A phase's age counts wall-clock time while its
   frames skip time the tab was hidden, so keep the page in front for the whole path.
3. **Paste:** the screenshots (cropped to the overlay) or the fps line of each phase. Under 30 fps on any phase opens C24
   (diagonal speed, atlas split). Commit `test: record the mobile frame rate`.

### Closing the bench (24.12)

1. **[Avi]** Deletes the `cloudiator-bench` project and the "Cloudiator bench" Google client, removes `<bench-ref>.supabase.co`
   from the authorized domains, clears the Pages Preview variables and sets preview branches to None.
2. **[Claude after Avi's go]** `git push origin --delete bench`.
3. **[Claude]** Updates `release-evidence.md` (the URL and all evidence), this file, `runbook.md` (TLS, pause policy) and
   `HANDOFF.md`; commit `deploy: verify the public gladiator game`. The shared URL comes with its limits: the Google screen
   shows `<prod-ref>.supabase.co`, and the free tier can pause the project.

## Part 4: later releases and rollback

### A later release

Decision 2: `db push`, then `functions deploy`, then the `release` fast-forward. Read each new migration's
"Release (Task NN)" note in [migrations.md](migrations.md) first; a note that orders things differently wins (for example a
new rules version: [runbook, "Retained-rule deployments"](runbook.md#retained-rule-deployments)).

1. **[Claude]** `<deploy-commit>` is reviewed, passed the gate of record and is pushed; the LF check and linked-ref check pass
   (`<ref>` = `<prod-ref>`).
2. **[Claude after Avi's go]** `npx supabase db push --dry-run`: exactly the new migrations. **[Claude after Avi's go]**
   `npx supabase db push --yes`.
3. **[Avi + Claude]** The access audit and the fingerprint as in Part 2's Parity (the access audit after every migration:
   AGENTS.md, Task 23.1 rule). On a live database the fingerprint's `seed-*` lines count rows that play has changed; compare
   every other section.
4. **[Claude after Avi's go]** `npx supabase functions deploy <changed function> --project-ref <prod-ref>`, then the probes.
5. **[Claude]** The local build check; **[Claude after Avi's go]** the `release` fast-forward; **[Avi]** the build status;
   **[Claude]** the deployed harness.
6. **[Avi]** `npm run health -- --remote` after the next boundary (runbook: after every deployment).

### Rollback

- **The client is safe to roll back** when the older client works with the current schema and functions: Pages →
  Deployments → an earlier production deployment → Rollback. Never move `release` backwards or force-push it; the next
  release fast-forwards it with the fix.
- **An Edge function can be redeployed** from an LF checkout of an earlier commit, after Avi's go, only when that version
  accepts the current schema. An older worker can fail jobs into operator state (migrations.md M09–M12 notes); run the health
  check and [manual recovery](runbook.md#manual-recovery-after-three-failures) if `operator-jobs` appears.
- **Migrations are forward-only.** There is no down migration. Never edit or delete a committed migration, never use
  `migration repair` to hide one, and never run `db reset --linked` on production. A fix is a new, reviewed migration.
- **The emergency brake** is [pausing the scheduler](runbook.md#pausing-and-resuming-the-scheduler): commands keep working,
  boundaries wait, and catch-up runs after the resume.
- **The last resort** is a restore from the latest export into a new project (24.10's procedure). Everything after the export
  is lost, and every player signs in again.
- **Secrets** rotate as in [runbook, "Secret rotation"](runbook.md#secret-rotation). A changed Pages variable takes effect only
  with a new build (a retried deployment or the next fast-forward).
