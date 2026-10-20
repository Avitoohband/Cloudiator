import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';
import { handleWorker, prepareActivityV1 } from '../../supabase/functions/_shared/backend/jobs.ts';

// Executed by the pinned Deno runtime as a mandatory part of `npm run typecheck`.
// Database/Auth authority is separately verified by the real local integration suite.
Deno.test('Edge runtime loads canonical domain modules and enforces the command boundary', async () => {
  const id = '8d2f0216-c41a-4056-89aa-8f0c1da612e0';
  const command = { kind: 'create-character' as const, operationId: id, name: 'Runtime Fighter', classId: 'guardian' as const,
    allocation: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 } };
  const prepared = prepareCreation(command);
  if (prepared.staminaMaximum !== 104 || prepared.starterItems[0].stats.damage !== 6) throw new Error('Canonical creation preparation failed');
  const response = await handleCommand(new Request('http://local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...command, ownerId: id }) }), {
    allowedOrigins: [], verifyActor: async () => ({ userId: id }),
    database: { plan: async () => { throw new Error('Untrusted command reached mutation'); }, inventory: async () => { throw new Error('Untrusted command reached mutation'); },
      consumeRateLimit: async () => null, createGladiator: async () => { throw new Error('Untrusted command reached mutation'); },
      market: async () => { throw new Error('Untrusted command reached mutation'); }, setTournamentOptIn: async () => { throw new Error('Untrusted command reached mutation'); } },
  });
  if (response.status !== 400 || (await response.json()).code !== 'invalid') throw new Error('Authority rejection failed');
});

// Task 24.1 (plan Decision 9): the preflight's Max-Age in the Edge runtime itself, beside the Node unit test.
Deno.test('Edge runtime lets the browser cache a granted command preflight, and grants another origin nothing', async () => {
  const deps = { allowedOrigins: ['http://127.0.0.1:3000'], verifyActor: async () => { throw new Error('A preflight reached identity'); },
    database: {} as Parameters<typeof handleCommand>[1]['database'] };
  const preflight = (origin: string) => handleCommand(new Request('http://local', { method: 'OPTIONS', headers: { Origin: origin } }), deps);
  const allowed = await preflight('http://127.0.0.1:3000');
  if (allowed.status !== 204 || allowed.headers.get('Access-Control-Allow-Origin') !== 'http://127.0.0.1:3000'
    || allowed.headers.get('Access-Control-Max-Age') !== '7200') throw new Error('Preflight cache grant failed');
  const refused = await preflight('https://evil.example');
  if (refused.status !== 403 || [...refused.headers.keys()].some(name => name.startsWith('access-control-'))) throw new Error('Preflight refusal failed');
});

Deno.test('Edge runtime loads canonical activity preparation and enforces the private worker secret', async () => {
  const gladiatorId = '8d2f0216-c41a-4056-89aa-8f0c1da612e0';
  const prepared = prepareActivityV1({ gladiatorId, slotIndex: 300, rulesVersion: 'v1', level: 1, earnedPoints: 10, items: [],
    build: { version: 1, classId: 'berserker', stance: 'balanced', allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 },
      equipment: { weapon: null, offHand: null, head: null, body: null, feet: null } } });
  if (prepared.costs.training !== 20 || prepared.costs.rest !== 0 || prepared.staminaMaximum !== 100) throw new Error('Canonical activity preparation failed');
  const response = await handleWorker(new Request('http://local', { method: 'POST', headers: { Authorization: 'Bearer publishable-key' } }), {
    secret: 'deno-runtime-worker-secret-0123456789abcdef', run: async () => { throw new Error('Unauthenticated worker reached the database'); },
  });
  if (response.status !== 401) throw new Error('Worker authority rejection failed');
});
