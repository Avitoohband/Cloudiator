import { expect, it } from 'vitest';

const script = '../../scripts/create-bots.mjs';

it('requires explicit matching local or hosted targets before the operator opens a connection', async () => {
  const { botTarget } = await import(script);
  const local = 'postgres://postgres:fixture@127.0.0.1:54322/postgres';
  const ref = 'abcdefghijklmnopqrst';
  const hosted = `postgresql://postgres:fixture@db.${ref}.supabase.co:5432/postgres`;
  expect(botTarget(['--local'], local)).toBe('local');
  expect(botTarget(['--production', ref], hosted)).toBe('production');
  for (const [args, target] of [
    [[], local], [['--local'], hosted], [['--production', ref], local],
    [['--production', ref], hosted.replace(ref, 'tsrqponmlkjihgfedcba')],
    [['--local'], 'postgres://postgres:fixture@127.0.0.1:5432/postgres'],
    [['--local'], local + '?host=outside.invalid'],
    [['--local'], local.replace('postgres:', 'https:')], [['--local'], 'fixture-bad-url'],
  ] as const) {
    expect(() => botTarget(args, target)).toThrow('Invalid bot operator target.');
  }
});
