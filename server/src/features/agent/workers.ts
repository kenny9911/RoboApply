// server/src/features/agent/workers.ts — queue workers of Ready to apply (WP-52).
//
// server/src/platform/queue/registry.ts imports `workers` from every area.
//   - 'agent.prepare': prepare one kit (tailored resume through RES, cover
//     letter through CL when the post asks for one, the profile's missing
//     fields). Runs inside `runWithBrand(item.brand)`. Never submits (D1).
//     A failed kit is marked `failed` with a short code and its `ready_kits`
//     credit is released; a step failure with a domain code is never rethrown.
//     An unexpected error (the database, or a tailor fault with no code) is
//     retried once — the retry reuses the attempt's idempotency keys, so
//     tailoring and letters never charge twice; on the last
//     attempt the kit is marked `failed` ('internal') instead of rethrowing,
//     so no kit stays `preparing` (the ready-weekly sweep covers a worker that
//     never got that far).

import type { WorkerDefinition } from '../../platform/queue/index.js';
import { PermanentWorkError } from '../../platform/queue/index.js';
import type { PreparePayload } from './deps.js';
import { AGENT_WORK_KINDS } from './kinds.js';

export { AGENT_WORK_KINDS } from './kinds.js';

function asPayload(value: unknown): PreparePayload {
  const p = (value ?? {}) as Partial<PreparePayload>;
  if (typeof p.queueItemId !== 'string' || typeof p.userId !== 'string' || typeof p.attempt !== 'number') {
    throw new PermanentWorkError('agent.prepare: bad payload');
  }
  return {
    queueItemId: p.queueItemId,
    userId: p.userId,
    attempt: p.attempt,
    reservationId: typeof p.reservationId === 'string' ? p.reservationId : null,
    part: p.part === 'resume' ? 'resume' : 'all',
    instruction: typeof p.instruction === 'string' ? p.instruction : undefined,
  };
}

export const prepareWorker: WorkerDefinition = {
  kind: AGENT_WORK_KINDS.agentPrepare,
  // Each kit runs a tailor (and maybe a letter) call: keep a drain from starting too many at once.
  concurrency: 2,
  async handler(item) {
    const payload = asPayload(item.payload);
    const { getAgentService } = await import('./service.js');
    await getAgentService().runPrepare(payload, { finalAttempt: item.attempts >= item.maxAttempts });
  },
};

export const workers: WorkerDefinition[] = [prepareWorker];
