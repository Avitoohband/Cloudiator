import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DEFAULT_EXECUTORS } from '../supabase/functions/_shared/backend/jobs.ts';

// Task 23.6 (R6; spec §11: "Keep migrations, rule versions, and static builds compatible with in-progress snapshots during
// releases"). A release can deploy migrations while a boundary is open and jobs, snapshots and plans are in progress. Those
// rows are immutable inputs (the guard triggers) and run with the executors of their own rules version (runbook,
// "Retained-rule deployments"). This file checks, over the whole migration history, that no migration rewrites, removes or
// orphans that state at its top level, and that every rules version a migration seeds has the worker's executors; the live
// catalog side is tests/db/rule-retention.test.ts. Function bodies are not checked here: their writes are the guarded runtime.

/** The top-level statements of a SQL file: comments dropped, string and dollar-quoted bodies reduced to placeholders. */
function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i], next = sql[i + 1];
    if (c === '-' && next === '-') { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end; continue; }
    if (c === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      current += `'${sql.slice(i + 1, j).replace(/\s+/g, ' ').slice(0, 40)}'`;
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) { const end = sql.indexOf(tag, i + tag.length); current += '$body$'; i = end < 0 ? sql.length : end + tag.length; continue; }
    }
    if (c === ';') { if (current.trim()) statements.push(current.replace(/\s+/g, ' ').trim()); current = ''; i++; continue; }
    current += c;
    i++;
  }
  if (current.trim()) statements.push(current.replace(/\s+/g, ' ').trim());
  return statements;
}

/** Rows a boundary in progress depends on: its frozen cohort, its jobs and their inputs, snapshots, plans and guards. */
const IN_PROGRESS = ['private.jobs', 'private.job_dependencies', 'private.activity_snapshots', 'private.boundaries', 'private.boundary_members',
  'private.boundary_work', 'private.rules_versions', 'private.expedition_plans', 'private.arena_assignments', 'private.arena_assignment_sides',
  'private.tournaments', 'private.tournament_entries', 'private.tournament_bouts', 'private.pending_build_preparations', 'private.settled_slots',
  'public.activities', 'public.activity_stages'];
/** Reviewed top-level backfills: neither touches in-progress state. */
const REVIEWED_UPDATES = new Map([
  ['20261013065108_inventory_shops.sql', /^update public\.gladiators set peak_strength=greatest\(peak_strength,28\)$/],
  ['20261019102324_timing.sql', /^update public\.world_revision_state r set published_slot_index=c\.published_slot from private\.coordinator c /],
]);
const name = (raw: string) => raw.replace(/"/g, '').toLowerCase();

/** Every top-level statement of `file` that could rewrite, remove or orphan state an in-progress boundary depends on. */
function retentionFindings(file: string, sql: string): string[] {
  const findings: string[] = [];
  const statements = topLevelStatements(sql);
  const createdGuards = new Set(statements.flatMap(s => {
    const m = /^create (?:or replace )?(?:constraint )?trigger "?(guard\w*)"? .*? on ("?\w+"?\."?\w+"?)/i.exec(s);
    return m ? [name(m[2])] : [];
  }));
  for (const statement of statements) {
    const s = statement.toLowerCase();
    const at = `${file}: ${statement.slice(0, 120)}`;
    if (/^(delete from|truncate)\b/.test(s)) findings.push(`removes rows: ${at}`);
    if (/^drop (table|schema)\b/.test(s)) findings.push(`drops a table: ${at}`);
    if (/^alter table .*\b(drop column|rename\b|alter column \S+ (set data )?type\b|disable trigger)/.test(s)) findings.push(`rewrites a table: ${at}`);
    if (/^update\b/.test(s)) {
      const target = name(/^update (?:only )?("?\w+"?\."?\w+"?)/.exec(s)?.[1] ?? '');
      if (IN_PROGRESS.includes(target)) findings.push(`rewrites in-progress state: ${at}`);
      else if (!REVIEWED_UPDATES.get(file)?.test(s)) findings.push(`unreviewed backfill: ${at}`);
    }
    if (/^insert into "?private"?\."?rules_versions"?/.test(s) && !/on conflict do nothing$/.test(s)) findings.push(`changes a rules version: ${at}`);
    const dropped = /^drop trigger (?:if exists )?"?(guard\w*)"? on ("?\w+"?\."?\w+"?)/.exec(s);
    if (dropped && !createdGuards.has(name(dropped[2]))) findings.push(`drops a guard without its replacement: ${at}`);
  }
  return findings;
}

const MIGRATIONS = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).sort();
const read = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');

describe('in-progress snapshots across migrations', () => {
  it('finds a statement that would rewrite, remove or orphan in-progress state', () => {
    // The checker itself, on statements a future migration must not contain.
    expect(retentionFindings('m.sql', `
      delete from private.jobs where status = 'pending';
      truncate private.activity_snapshots;
      alter table private.jobs drop column seed;
      alter table "private"."jobs" alter column "input" type text;
      alter table private.jobs disable trigger guard_job;
      update private.jobs set input = '{}' where status <> 'completed';
      update public.gladiators set level = 1;
      insert into private.rules_versions(version, active) values ('v2', true);
      drop trigger if exists guard_job on private.jobs;
      drop table private.expedition_plans;
    `).map(f => f.split(':')[0])).toEqual(['removes rows', 'removes rows', 'rewrites a table', 'rewrites a table', 'rewrites a table',
      'rewrites in-progress state', 'unreviewed backfill', 'changes a rules version', 'drops a guard without its replacement', 'drops a table']);
    // What migrations do and may: functions whose bodies write (the guarded runtime), additive columns, a replaced guard.
    expect(retentionFindings('m.sql', `
      create or replace function private.f() returns void language plpgsql as $$ begin delete from private.jobs; update private.jobs set status='x'; end $$;
      alter table "public"."world_revision_state" add column "published_slot_index" bigint;
      insert into private.rules_versions(version,active) values('v1',true) on conflict do nothing;
      drop trigger if exists "guard_frozen" on "public"."tournament_bout_results";
      CREATE TRIGGER guard_tournament_bout_result BEFORE UPDATE ON public.tournament_bout_results FOR EACH ROW EXECUTE FUNCTION private.g();
      comment on table private.jobs is 'delete from private.jobs; is only text';
    `)).toEqual([]);
  });

  it('holds over every migration in the history', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(20);
    expect(MIGRATIONS.flatMap(file => retentionFindings(file, read(file)))).toEqual([]);
  });

  it('gives every rules version a migration seeds the worker executors of each job kind', () => {
    const seeded = MIGRATIONS.flatMap(file => topLevelStatements(read(file))
      .flatMap(s => /^insert into "?private"?\."?rules_versions"?\s*\(version,\s*active\) values\s*\('(\w+)'/i.exec(s)?.[1] ?? []));
    expect(seeded).toEqual(['v1']);
    for (const version of seeded) {
      expect(Object.keys(DEFAULT_EXECUTORS), version).toContain(version);
      // Settlements run in SQL (settle_activity); every other kind needs this version's executor.
      expect(Object.keys(DEFAULT_EXECUTORS[version]).sort(), version).toEqual(['pair', 'prepare', 'reveal', 'simulation']);
    }
  });
});
