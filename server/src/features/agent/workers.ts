// server/src/features/agent/workers.ts — STUB (FND-3). Owner: WP-52.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'agent.prepare': prepare one Ready-to-apply kit (tailored resume, cover letter, answers). Never submits (D1).

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const AGENT_WORK_KINDS = { agentPrepare: 'agent.prepare' } as const;

export const workers: WorkerDefinition[] = [];
