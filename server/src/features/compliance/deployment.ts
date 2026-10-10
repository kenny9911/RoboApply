// server/src/features/compliance/deployment.ts
//
// Deployment facts the consent catalog and the disclosures both read. A leaf
// module (no imports from this area), so consents.ts can build its prose from
// disclosures.ts without an import cycle.

import type { EnvSource } from '../../platform/brand/brandEnv.js';

/** GoApply data is processed outside the mainland unless the deployment says otherwise (CN-0). */
export function isOffshore(env: EnvSource = process.env): boolean {
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase() !== 'cn-mainland';
}
