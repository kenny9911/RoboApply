// server/src/features/compliance/workers.ts — queue workers of the compliance area (WP-13).
//
// server/src/platform/queue/registry.ts imports `workers` from every area and
// registers them.
//   - 'compliance.export': build a personal-data export (dataExport.ts).
//   - 'compliance.purge':  close and delete an account after a withdrawn
//                          cross-border consent (purge.ts).
// Importing this module also registers the area's email templates.

import type { WorkerDefinition } from '../../platform/queue/index.js';
import { handleDataExport } from './dataExport.js';
import { handleAccountPurge } from './purge.js';
import { COMPLIANCE_WORK_KINDS } from './kinds.js';
import './emails.js';

export { COMPLIANCE_WORK_KINDS } from './kinds.js';

export const workers: WorkerDefinition[] = [
  { kind: COMPLIANCE_WORK_KINDS.dataExport, handler: async (item) => handleDataExport(item), concurrency: 2 },
  {
    kind: COMPLIANCE_WORK_KINDS.retentionPurge,
    handler: async (item) => {
      await handleAccountPurge(item);
    },
    concurrency: 1,
  },
];
