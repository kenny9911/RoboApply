// server/src/features/onboarding-cn/apply.ts — write a validated GoApply step's effects.
//
// WP-30's `PUT /onboarding/steps/:step` stores `onboardingAnswers[step]` and
// the stage; for GoApply it then calls `applyCnStep(userId, brand, result,
// opts)` with the `validateCnStep` result. This writes, in order:
//   1. consent records (compliance `recordConsent`, with the prose version the
//      user saw — the agreement, age, CN-0 cross-border, AI processing,
//      个性化推荐 and marketing answers, each its own record);
//   2. `RAProfile.cnFields` keys (profile service `patch`, which merges and
//      refuses anything outside the documented keys);
//   3. the default search profile's filters (search `patchFilters`, retried
//      once on a version conflict).
// Every write is idempotent for the same body: consent records append to the
// ledger (latest wins), cnFields and filters are set to the same values.
// No LLM call and no resume parse happens here (manual mode, AI consent off).

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CnStepValidation } from './contract.js';

export interface ApplyCnStepDeps {
  recordConsent?: (input: { userId: string; brand: ProductBrand; type: string; granted: boolean; proseVersion: string; locale?: string | null }) => Promise<unknown>;
  patchCnFields?: (userId: string, brand: ProductBrand, cnFields: Record<string, unknown>) => Promise<unknown>;
  patchDefaultFilters?: (userId: string, patch: Record<string, unknown>) => Promise<unknown>;
}

export interface ApplyCnStepOptions {
  /** Locale of the consent prose shown (zh or en). */
  locale?: string | null;
}

export interface ApplyCnStepResult {
  consentsRecorded: number;
  cnFieldsWritten: boolean;
  filtersWritten: boolean;
}

async function defaultRecordConsent(input: Parameters<NonNullable<ApplyCnStepDeps['recordConsent']>>[0]): Promise<unknown> {
  const { recordConsent } = await import('../compliance/index.js');
  return recordConsent(input);
}

async function defaultPatchCnFields(userId: string, brand: ProductBrand, cnFields: Record<string, unknown>): Promise<unknown> {
  const { createProfileService } = await import('../profile/index.js');
  return createProfileService().patch(userId, { cnFields }, { brand });
}

async function defaultPatchDefaultFilters(userId: string, patch: Record<string, unknown>): Promise<unknown> {
  const { searchProfileService, VersionConflictError } = await import('../search/index.js');
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = await searchProfileService.list(userId);
    const target = list.profiles.find((p) => p.isDefault) ?? list.profiles[0];
    if (!target) return null;
    try {
      return await searchProfileService.patchFilters(userId, target.id, target.version, patch);
    } catch (err) {
      if (!(err instanceof VersionConflictError) || attempt === 1) throw err;
    }
  }
  return null;
}

export async function applyCnStep(
  userId: string,
  brand: ProductBrand,
  result: CnStepValidation,
  opts: ApplyCnStepOptions = {},
  deps: ApplyCnStepDeps = {},
): Promise<ApplyCnStepResult> {
  const out: ApplyCnStepResult = { consentsRecorded: 0, cnFieldsWritten: false, filtersWritten: false };
  if (!result.ok || !result.effects) return out;
  const { consents, cnFields, filterPatch } = result.effects;

  if (consents.length) {
    const proseVersion = typeof result.answers?.proseVersion === 'string' ? result.answers.proseVersion : null;
    if (!proseVersion) throw new Error('applyCnStep: consent effects need the proseVersion answer');
    const record = deps.recordConsent ?? defaultRecordConsent;
    for (const c of consents) {
      await record({ userId, brand, type: c.type, granted: c.granted, proseVersion, locale: opts.locale ?? null });
      out.consentsRecorded++;
    }
  }
  if (cnFields && Object.keys(cnFields).length) {
    await (deps.patchCnFields ?? defaultPatchCnFields)(userId, brand, cnFields);
    out.cnFieldsWritten = true;
  }
  if (filterPatch && Object.keys(filterPatch).length) {
    await (deps.patchDefaultFilters ?? defaultPatchDefaultFilters)(userId, filterPatch);
    out.filtersWritten = true;
  }
  return out;
}
