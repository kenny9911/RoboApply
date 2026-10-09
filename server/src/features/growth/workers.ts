// server/src/features/growth/workers.ts — STUB (FND-3). Owner: WP-23.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'growth.referralRisk': referral risk scoring; holds rewards for review (WP-60 extends).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const GROWTH_WORK_KINDS = { referralRiskHold: 'growth.referralRisk' } as const;

export const workers: WorkerDefinition[] = [];
