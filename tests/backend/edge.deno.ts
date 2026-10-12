import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { prepareCreation } from '../../supabase/functions/_shared/backend/database.ts';

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
    database: { consumeRateLimit: async () => null, createGladiator: async () => { throw new Error('Untrusted command reached mutation'); } },
  });
  if (response.status !== 400 || (await response.json()).code !== 'invalid') throw new Error('Authority rejection failed');
});
