// server/src/platform/residency/summary.ts
//
// Plain facts about where a brand's data is processed on this deployment,
// derived from env only (no I/O). The privacy notice and the settings
// "#privacy" section (WP-13, PRODUCT F-TRUST-06) render from it, so the
// notice can never claim more than the deployment does (D3): e.g. no "data
// stays in mainland China" line while GoApply runs offshore or keeps its
// files on the shared store (D5: the shared stack is GoApply's fallback).

import type { EnvSource } from '../brand/brandEnv.js';
import { brandEnv, brandStack } from '../brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import { hostOf } from '../llm/brandPolicy.js';
import type { PiiKind } from '../pii/redact.js';
import { deployRegion, residencyStage, type DeployRegion, type ResidencyStage } from './deployRegion.js';
import { goHireParseActive } from './egressPolicy.js';
import { resumeUploadPolicy } from './uploadPolicy.js';

export interface ResidencySummary {
  brand: BrandId;
  region: DeployRegion;
  stage: ResidencyStage;
  /** kept: in the store the brand writes to; not_kept: parsed in memory only; unavailable: uploads refused. */
  originalFiles: 'kept' | 'not_kept' | 'unavailable';
  /**
   * Which store the brand's files go to: `own` only for GoApply with its own
   * bucket (`CN_S3_BUCKET`), `shared` otherwise (the bucket RoboApply uses).
   */
  storage: 'own' | 'shared';
  /** Host of that store's endpoint when original files are kept there. */
  storageHost: string | null;
  /**
   * 'gohire_mainland': PDF uploads are parsed by the GoHire API on a mainland
   * server — only when that call is really made here (brand opted in, enabled,
   * keyed, egress allowed; the same check the parse service runs).
   */
  resumeParsing: 'gohire_mainland' | 'local';
  /** What is removed from parsed text before it is stored. */
  redactedBeforeStorage: readonly PiiKind[];
  /** Photos and images are discarded instead of stored. */
  imagesDiscarded: boolean;
}

export function residencySummary(brand: BrandId | ProductBrand, env: EnvSource = process.env): ResidencySummary {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  const policy = resumeUploadPolicy(b, env);
  const kept = policy.originals === 'store';
  return {
    brand: b.id,
    region: deployRegion(env),
    stage: residencyStage(b, env),
    originalFiles: kept ? 'kept' : policy.originals === 'discard' ? 'not_kept' : 'unavailable',
    storage: brandStack(b, 'storage', env),
    // `brandEnv` reads the storage group as one set, so this is the endpoint of the store really used.
    storageHost: kept ? hostOf(brandEnv(b, 'S3_ENDPOINT', env) ?? '') : null,
    resumeParsing: goHireParseActive(b, env) ? 'gohire_mainland' : 'local',
    redactedBeforeStorage: policy.redactKinds,
    imagesDiscarded: policy.dropImages,
  };
}
