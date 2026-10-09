// server/src/features/onboarding/workers.ts — STUB (FND-3). Owner: WP-30.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'onboarding.match': O6 matching work that passed 120 s continues here, run by queue-drain.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const ONBOARDING_WORK_KINDS = { onboardingMatch: 'onboarding.match' } as const;

export const workers: WorkerDefinition[] = [];
