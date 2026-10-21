import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The game's own command parser and creation preparation, loaded through Node's type stripping (Node 22.18 or later; the
// project pins 22.19.0).
import { parseCommand } from '../supabase/functions/_shared/backend/commands.ts';
import { prepareCreation } from '../supabase/functions/_shared/backend/database.ts';
import { RULES_V1 } from '../supabase/functions/_shared/domain/rules-v1.ts';

// Task 24.2b (plan docs/superpowers/plans/2026-10-20-task-24-launch.md, Decision 4): the bench seed generator.
//   node scripts/bench-seed.mjs [--count 50] [--seed bench] [--out <file>]
// It writes one SQL file (default `bench-seed.sql` in the repository root, git-ignored) that Avi runs once in the temporary
// bench project's SQL editor, after the migrations and before activation (Task 24.7). The file gives the 50-actor phone test
// (24.11) and the hosted 50-character boundary benchmark (24.9) their world: `--count` characters, each with an owner account
// of its own, every phase on the Woodland expedition (Task 23.3's all-expedition worst case). How to run it and what to paste
// back: docs/operations/runbook.md, "Bench seed". tests/db/bench-seed.test.ts applies the file to the local stack.
//
// Local and credential-free: it reads only this repository, connects to nothing, and prints the file's path, the count, the
// seed and the file's SHA-256. The same options always write the same bytes: every id derives from the seed, and nothing
// depends on the time or on chance.
//
// Owners. A character's owner must be an Auth account (characters, receipts and owner signals reference auth.users), so the
// game's functions cannot run for a synthetic actor id without one, and no SQL function of the Auth server creates one. The
// SQL therefore inserts each account itself, shaped like the local fixtures' real-looking accounts (tests/fixtures/db.ts: a
// Google identity whose provider id and `sub` are the account id), with the same columns null or empty as an account the Auth
// admin API makes (tests/db/bench-seed.test.ts), and with:
//   - an address on the reserved `.invalid` domain (RFC 2606), bench-001@bench.invalid and so on: it can receive no mail, so
//     no Google account carries it, and the dashboard shows at a glance which accounts are the bench's;
//   - no password at all (an empty one), so it cannot sign in with one; the project allows Google sign-in only anyway;
//   - a provider id that is a UUID, which never equals a Google account's numeric subject, so no Google sign-in lands on it.
// The trade-off: these inserts bypass the Auth server, so an Auth schema the local stack does not have can make them fail
// (atomically, below), and the hosted owner's INSERT on auth.users and auth.identities is untested until the bench run. The
// bench project is deleted afterwards (Task 24.12), accounts and all.
//
// Characters. Everything else goes through the game's own functions, in the order the Edge command handler calls them
// (supabase/functions/_shared/backend/commands.ts): the rate check every command makes (it also records the owner's activity
// signal), creation's own rate check, then public.create_gladiator with exactly the input the Edge function prepares
// (prepareCreation), and two public.edit_schedule commands that set the morning and the evening to Woodland (the creation
// schedule is Training / Woodland / Rest). Each command passes the HTTP parser (parseCommand) here first. The builds come with
// creation: the classes rotate and the allocations vary with the seed, but endurance stays 2, so every character affords
// exactly three expeditions before it rests and all of them stay in step (three all-expedition boundaries in every four).
//
// Refusals. The SQL refuses (raises, and saves nothing) unless the database is marked as the bench and the project is empty
// and not activated. The mark (fix round 1) is the database comment 'cloudiator-bench' or the schema cloudiator_bench_marker,
// set by a separate bench-only runbook step that this file never takes, since an empty production project before activation
// looks like an empty bench in every other way. Empty and not activated: no account at all (a bench seed account means it
// was seeded already; any other means it is not the new bench project), no character, no season epoch, and the scheduler
// off. It takes an advisory lock first, so two runs at once cannot both pass. It is one DO block, so
// any failure (a refusal, a refused insert, or a slot boundary passing between a creation and its schedule edits) leaves
// nothing behind; a read-only SELECT then prints the counts to paste back, with the seeding slot and time and the first
// boundary with members. Creation records the creation slot S as each character's processed slot, the coordinator starts at
// S + 1, and a boundary with members before the season epoch waits for it forever (the epoch cannot change once set), so the
// bench's epoch must be at most S + 1, even if that slot has passed (fix round 1; the runbook's "Bench seed").

const root = fileURLToPath(new URL('..', import.meta.url));
/** The default output: git-ignored (`/bench-seed.sql` in .gitignore). */
export const DEFAULT_OUT = resolve(root, 'bench-seed.sql');
/** The reserved domain (RFC 2606) of every bench seed account's address. */
export const BENCH_DOMAIN = 'bench.invalid';
const USAGE = 'usage: node scripts/bench-seed.mjs [--count <1-200>] [--seed <1-64 letters, digits, ".", "_" or "-">] [--out <file>]';
const CLASSES = ['berserker', 'guardian', 'duelist'];
const WOODLAND = Object.freeze({ kind: 'expedition', expeditionId: 'woodland' });
/** The phases the creation schedule (Training / Woodland / Rest, public.create_gladiator) does not already spend on Woodland. */
const EDITED_PHASES = ['morning', 'evening'];

/** The command line options; anything else throws the usage line. */
export function parseArgs(argv) {
  const options = { count: 50, seed: 'bench', out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (value === undefined) throw new Error(USAGE);
    if (name === '--count' && /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 200) options.count = Number(value);
    else if (name === '--seed' && /^[A-Za-z0-9._-]{1,64}$/.test(value)) options.seed = value;
    else if (name === '--out' && value !== '') options.out = resolve(value);
    else throw new Error(USAGE);
  }
  return options;
}

const digest = (seed, label) => createHash('sha256').update(`cloudiator-bench-seed\0${seed}\0${label}`).digest();
/** A UUID derived from the seed and a label: RFC 9562 version 8 (custom), lowercase as PostgreSQL prints it. */
function uuidFor(seed, label) {
  const bytes = digest(seed, label).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Creation's 10 points: endurance 2, the other 8 spread over the other four attributes by the seed. */
function allocationFor(seed, index) {
  const bytes = digest(seed, `allocation:${index}`);
  const allocation = { strength: 0, agility: 0, vitality: 0, endurance: 2, precision: 0 };
  const free = ['strength', 'agility', 'vitality', 'precision'];
  for (let point = 0; point < 8; point++) allocation[free[bytes[point] % free.length]]++;
  return allocation;
}

/**
 * The seed's characters: each owner account (ids, address), the creation input the Edge function would send, and the two
 * schedule edits. Throws if the game would refuse any command, or if the characters' expedition cycles would drift apart.
 */
export function benchCharacters({ count, seed }) {
  const characters = [];
  for (let i = 0; i < count; i++) {
    const number = String(i + 1).padStart(3, '0');
    const id = (kind) => uuidFor(seed, `${kind}:${number}`);
    const command = { kind: 'create-character', operationId: id('creation'), name: `Bench ${number}`, classId: CLASSES[i % CLASSES.length],
      allocation: allocationFor(seed, i) };
    const edits = EDITED_PHASES.map((phase, edit) => ({ kind: 'edit-schedule', operationId: id(`schedule-${phase}`), expectedVersion: edit + 1,
      phase, choice: { ...WOODLAND } }));
    for (const value of [command, ...edits]) if (parseCommand(value) === null) throw new Error(`the game would refuse a command of Bench ${number}`);
    characters.push({ userId: id('account'), identityId: id('identity'), email: `bench-${number}@${BENCH_DOMAIN}`, name: command.name,
      creation: prepareCreation(command), edits });
  }
  const affordable = new Set(characters.map(c => Math.floor(c.creation.staminaMaximum / RULES_V1.activityStamina.expedition)));
  if (affordable.size > 1) throw new Error('the characters would afford different numbers of expeditions, and their rests would drift apart');
  return characters;
}

const ALL_WOODLAND = JSON.stringify({ morning: WOODLAND, afternoon: WOODLAND, evening: WOODLAND });

/** The SQL file for `count` characters from `seed`: LF lines, ending in a newline. */
export function benchSeedSql({ count, seed }) {
  const characters = benchCharacters({ count, seed });
  const data = characters.map(c => JSON.stringify({ userId: c.userId, identityId: c.identityId, email: c.email, name: c.name, creation: c.creation,
    edits: c.edits }));
  if (data.some(line => line.includes('$bench'))) throw new Error('the character data would end its own quoting');
  const lines = [
    `-- Cloudiator bench seed: ${count} characters (node scripts/bench-seed.mjs --count ${count} --seed ${seed}).`,
    '-- Task 24.2b, plan Decision 4. How to run it and what to paste back: docs/operations/runbook.md, "Bench seed".',
    '-- ONLY for the temporary bench project ("cloudiator-bench"), once, in its SQL editor, after the migrations and before',
    '-- activation. It refuses (raises, and saves nothing) unless the database is marked as the bench (a separate runbook step)',
    '-- and the project is empty and not activated: no account, no character, no season epoch, the scheduler off. Set the',
    '-- bench\'s season epoch at most at first_member_boundary (the last SELECT). Each owner is a synthetic account on the',
    '-- reserved bench.invalid domain, with no password and a Google identity no real Google account can match; each character',
    '-- is created and scheduled through the game\'s own functions, every phase on the Woodland expedition. One DO block: any',
    '-- failure leaves nothing behind. The SELECT at the end prints counts, slot numbers and the seeding time only.',
    'do $bench_seed$',
    'declare',
    '  characters constant jsonb := $bench_json$[',
    data.join(',\n'),
    ']$bench_json$::jsonb;',
    '  c jsonb;',
    '  e jsonb;',
    '  actor uuid;',
    '  result jsonb;',
    '  bench_accounts bigint;',
    '  other_accounts bigint;',
    '  existing_characters bigint;',
    '  epoch_set boolean;',
    '  scheduler_on boolean;',
    '  marked boolean;',
    "  reasons text[] := '{}';",
    'begin',
    '  -- One seed at a time: a second run started meanwhile waits here, then sees this one\'s accounts and refuses.',
    "  perform pg_advisory_xact_lock(hashtextextended('cloudiator-bench-seed', 0));",
    '  -- Only a database marked as the bench, by a separate bench-only step that this file never takes: the database comment',
    "  -- 'cloudiator-bench', or (where the owner cannot comment on the database) the schema cloudiator_bench_marker. An empty",
    '  -- production project before activation looks like an empty bench in every other way.',
    "  marked := coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') = 'cloudiator-bench'",
    "    or to_regnamespace('cloudiator_bench_marker') is not null;",
    "  if not marked then reasons := reasons || 'this database is not marked as the bench'::text; end if;",
    "  select count(*) filter (where email like 'bench-%@bench.invalid'), count(*) filter (where email is null or email not like 'bench-%@bench.invalid')",
    '    into bench_accounts, other_accounts from auth.users;',
    '  select count(*) into existing_characters from public.gladiators;',
    '  select exists(select 1 from private.season_epoch) into epoch_set;',
    '  select coalesce(bool_or(enabled), false) into scheduler_on from private.scheduler;',
    "  if other_accounts > 0 then reasons := reasons || format('accounts that are not bench seed accounts: %s', other_accounts); end if;",
    "  if bench_accounts > 0 then reasons := reasons || format('bench seed accounts (already seeded): %s', bench_accounts); end if;",
    "  if existing_characters > 0 then reasons := reasons || format('characters: %s', existing_characters); end if;",
    "  if epoch_set then reasons := reasons || 'the season epoch is set (activation comes after seeding)'::text; end if;",
    "  if scheduler_on then reasons := reasons || 'the scheduler is enabled (activation comes after seeding)'::text; end if;",
    '  if cardinality(reasons) > 0 then',
    "    raise exception using message = 'bench seed refused: ' || array_to_string(reasons, '; '),",
    "      hint = 'Run it only on the new, empty bench project, marked as the bench, after the migrations and before activation (docs/operations/runbook.md, \"Bench seed\").';",
    '  end if;',
    '  for c in select value from jsonb_array_elements(characters) loop',
    "    actor := (c->>'userId')::uuid;",
    '    -- The owner: the only rows written directly. No SQL function of the Auth server creates an account, and every game',
    '    -- table that names an owner references auth.users. Shaped as the Auth admin API shapes an account, with an empty password',
    '    -- and the same token columns empty (the Auth server cannot read an account whose token columns are null).',
    '    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_token,',
    '      recovery_token, email_change_token_new, email_change, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)',
    "    values ('00000000-0000-0000-0000-000000000000', actor, 'authenticated', 'authenticated', c->>'email', '', now(), '', '', '', '',",
    `      '{"provider": "google", "providers": ["google"]}', '{"email_verified": true}', now(), now());`,
    '    insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at)',
    "    values ((c->>'identityId')::uuid, actor, actor::text, 'google', jsonb_build_object('sub', actor::text, 'email', c->>'email'), now(), now());",
    '    -- The game\'s command path (supabase/functions/_shared/backend/commands.ts): the rate check of every command, which',
    '    -- records the owner\'s activity signal, creation\'s own rate check, then creation with the Edge function\'s prepared input.',
    '    if public.consume_command_rate(actor, false) is not null or public.consume_command_rate(actor, true) is not null then',
    "      raise exception 'bench seed: % was rate-limited', c->>'name';",
    '    end if;',
    "    result := public.create_gladiator(actor, (c->'creation'->'command'->>'operationId')::uuid, c->'creation');",
    "    if result->>'ok' is distinct from 'true' then",
    "      raise exception 'bench seed: creating % failed: %', c->>'name', coalesce(result->>'code', 'no code');",
    '    end if;',
    "    for e in select value from jsonb_array_elements(c->'edits') loop",
    "      if public.consume_command_rate(actor, false) is not null then raise exception 'bench seed: % was rate-limited', c->>'name'; end if;",
    "      result := public.edit_schedule(actor, (e->>'operationId')::uuid, jsonb_build_object('command', e, 'prepared', null));",
    "      if result->>'ok' is distinct from 'true' then",
    "        raise exception using message = format('bench seed: the %s schedule edit of %s failed: %s', e->>'phase', c->>'name',",
    "            coalesce(result->>'code', 'no code')),",
    "          hint = case when result->>'code' = 'processing' then 'A slot boundary passed during the seed; nothing was saved. Run it again.'",
    "            else 'Nothing was saved.' end;",
    '      end if;',
    '    end loop;',
    '  end loop;',
    'end;',
    '$bench_seed$;',
    '-- What to paste back: this one row. Expected: bench_accounts, accounts, characters and all_expedition_schedules all equal',
    '-- to the count above, epoch_set and scheduler_enabled false; every slot from all_expedition_from_slot on is an expedition',
    '-- for every character. The bench\'s season epoch must be at most first_member_boundary, even if that slot has passed:',
    '-- the coordinator starts at min(processed_slot_index) + 1 and waits for the epoch forever if that boundary comes before it',
    '-- (the epoch cannot be changed once set). seeded_slot and seeded_at_utc date the seed: the owners go idle 14 days later.',
    'select',
    "  (select count(*)::int from auth.users where email like 'bench-%@bench.invalid') as bench_accounts,",
    '  (select count(*)::int from auth.users) as accounts,',
    '  (select count(*)::int from public.gladiators) as characters,',
    `  (select count(*)::int from public.schedules where schedule = '${ALL_WOODLAND}'::jsonb) as all_expedition_schedules,`,
    '  exists(select 1 from private.season_epoch) as epoch_set,',
    '  (select coalesce(bool_or(enabled), false) from private.scheduler) as scheduler_enabled,',
    '  (select max(effective_slot_index) from public.schedule_revisions) as all_expedition_from_slot,',
    '  (select min(processed_slot_index) from public.gladiators) as seeded_slot,',
    "  (select to_char(to_timestamp((min(created_at_ms) / 1000.0)::double precision) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'",
    '    from public.gladiators) as seeded_at_utc,',
    '  (select min(processed_slot_index) + 1 from public.gladiators) as first_member_boundary;',
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
  const text = benchSeedSql(options);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  console.log(`bench-seed: wrote ${options.out}: ${options.count} characters, seed ${options.seed}, sha256 ${sha256}`);
  console.log('Run it once, in the bench project\'s SQL editor only, after the migrations and before activation (docs/operations/runbook.md, "Bench seed").');
}
