// server/src/features/resume/workers.ts — STUB (FND-3). Owner: WP-22.
//
// Queue workers for this area. server/src/platform/queue/registry.ts (FND-5) imports
// `workers` from every area and registers them. The list is empty until the owner
// adds handlers, so items of these kinds stay `queued` (never leased) until then.
// Kinds this area will handle:
//   - 'resume.grade': resume check for one resume variant.

import type { WorkerDefinition } from '../../platform/queue/index.js';

export const RESUME_WORK_KINDS = { resumeGrade: 'resume.grade' } as const;

export const workers: WorkerDefinition[] = [];
