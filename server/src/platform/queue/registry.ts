// server/src/platform/queue/registry.ts — registers every area's queue workers (FND-5).
//
// Each area exports `workers: WorkerDefinition[]` from its `workers.ts`
// (FND-3 created the stubs; owners add handlers). This module imports all of
// them statically and registers them once. `server/src/app.ts` imports it
// for its side effect, so the `queue-drain` cron and `kickDrain()` see every
// handler. A new area adds one import + one entry here (hot file: FND/INT).

import { registerWorkers } from './drain.js';
import type { WorkerDefinition } from './drain.js';
import { workers as jobsIngestWorkers } from '../../features/jobs/ingest/workers.js';
import { workers as jobsEnrichWorkers } from '../../features/jobs/enrich/workers.js';
import { workers as matchWorkers } from '../../features/match/workers.js';
import { workers as agentWorkers } from '../../features/agent/workers.js';
import { workers as seoWorkers } from '../../features/seo/workers.js';
import { workers as complianceWorkers } from '../../features/compliance/workers.js';
import { workers as cnJobsWorkers } from '../../features/cn/jobs/workers.js';
import { workers as resumeWorkers } from '../../features/resume/workers.js';
import { workers as notificationsWorkers } from '../../features/notifications/workers.js';
import { workers as onboardingWorkers } from '../../features/onboarding/workers.js';
import { workers as pushWorkers } from '../../features/push/workers.js';
import { workers as extensionWorkers } from '../../features/extension/workers.js';
import { workers as copilotWorkers } from '../../features/copilot/workers.js';
import { workers as growthWorkers } from '../../features/growth/workers.js';

/** Every area's worker list, by area (for diagnostics and tests). */
export const AREA_WORKERS: Readonly<Record<string, readonly WorkerDefinition<any>[]>> = {
  'jobs/ingest': jobsIngestWorkers,
  'jobs/enrich': jobsEnrichWorkers,
  match: matchWorkers,
  agent: agentWorkers,
  seo: seoWorkers,
  compliance: complianceWorkers,
  'cn/jobs': cnJobsWorkers,
  resume: resumeWorkers,
  notifications: notificationsWorkers,
  onboarding: onboardingWorkers,
  push: pushWorkers,
  extension: extensionWorkers,
  copilot: copilotWorkers,
  growth: growthWorkers,
};

let registered = false;

/** Registers every area's workers once (idempotent). Returns the number of definitions registered. */
export function registerAllWorkers(): number {
  if (registered) return 0;
  let count = 0;
  for (const defs of Object.values(AREA_WORKERS)) {
    registerWorkers(defs);
    count += defs.length;
  }
  registered = true;
  return count;
}

/** Test seam: allow `registerAllWorkers` to run again (after resetWorkerRegistryForTests). */
export function resetAreaWorkerRegistrationForTests(): void {
  registered = false;
}

registerAllWorkers();
