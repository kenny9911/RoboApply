// server/src/features/onboarding-cn/apply.ts — write a validated GoApply step's effects.
//
// WP-30's `PUT /onboarding/steps/:step` stores `onboardingAnswers[step]` and
// the stage; for GoApply it then calls `applyCnStep(userId, brand, result,
// opts)` with the `validateCnStep` result. This writes, in order:
//   1. consent records (compliance `recordConsent`, with the prose version the
//      user saw — the agreement, age, CN-0 cross-border, AI processing,
//      个性化推荐 and marketing answers, each its own record). The three
//      required consents are asked ONCE: when the ledger already holds a grant
//      of the text served now (given on the sign-up form), G1 shows them as
//      given instead of asking again, so no second record is written for a
//      text that was not put to the user a second time. A grant of an earlier
//      text is asked again and recorded under the new one;
//   2. `RAProfile.cnFields` keys (profile service `patch`, which merges and
//      refuses anything outside the documented keys);
//   3. the default search profile's filters (search `patchFilters`, retried
//      once on a version conflict).
// Every write is idempotent for the same body: consent records append to the
// ledger (latest wins), cnFields and filters are set to the same values.
// No LLM call and no resume parse happens here (manual mode, AI consent off).

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { CnStepValidation } from './contract.js';

/**
 * Consents that are asked once and cannot be re-answered on G1: the agreement
 * and the age confirmation end only with the account, and the CN-0
 * cross-border consent is withdrawn in Settings (which closes the account).
 */
export const CN_ONCE_ONLY_CONSENTS: readonly string[] = ['pipl_basic_processing', 'age_16_plus', 'pipl_cross_border'];

export interface ApplyCnStepDeps {
  recordConsent?: (input: { userId: string; brand: ProductBrand; type: string; granted: boolean; proseVersion: string; locale?: string | null }) => Promise<unknown>;
  /**
   * Consent types whose latest ledger record is a grant of the current text. Default: the
   * compliance ledger (`listConsents`). When a caller injects `recordConsent`
   * without this reader, no ledger is read and every consent is recorded.
   */
  grantedConsents?: (userId: string, brand: ProductBrand) => Promise<ReadonlySet<string>>;
  patchCnFields?: (userId: string, brand: ProductBrand, cnFields: Record<string, unknown>) => Promise<unknown>;
  patchDefaultFilters?: (userId: string, patch: Record<string, unknown>) => Promise<unknown>;
}

export interface ApplyCnStepOptions {
  /** Locale of the consent prose shown (zh or en). */
  locale?: string | null;
}

export interface ApplyCnStepResult {
  consentsRecorded: number;
  /** Required consents already granted in the ledger (sign-up), so not recorded again. */
  consentsAlreadyGiven: number;
  cnFieldsWritten: boolean;
  filtersWritten: boolean;
}

async function defaultRecordConsent(input: Parameters<NonNullable<ApplyCnStepDeps['recordConsent']>>[0]): Promise<unknown> {
  const { recordConsent } = await import('../compliance/index.js');
  return recordConsent(input);
}

/**
 * The consent types whose latest ledger record is a grant of the text served
 * NOW. A grant given to an earlier text (`answeredTextCurrent: false` — e.g.
 * the cross-border consent before its processor list was corrected) does not
 * count: G1 asks for it again, and the answer is recorded under the new text.
 */
export function consentsGivenToCurrentText(items: readonly { type: string; granted: boolean | null; answeredTextCurrent?: boolean | null }[]): Set<string> {
  return new Set(items.filter((i) => i.granted === true && i.answeredTextCurrent !== false).map((i) => i.type));
}

/** The ledger's granted types. A ledger that cannot be read counts as empty: the consents are then recorded (never dropped). */
async function defaultGrantedConsents(userId: string, brand: ProductBrand): Promise<ReadonlySet<string>> {
  try {
    const { listConsents } = await import('../compliance/index.js');
    const items = await listConsents(userId, brand, { locale: brand.defaultLocale });
    return consentsGivenToCurrentText(items);
  } catch {
    return new Set();
  }
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
  const out: ApplyCnStepResult = { consentsRecorded: 0, consentsAlreadyGiven: 0, cnFieldsWritten: false, filtersWritten: false };
  if (!result.ok || !result.effects) return out;
  const { consents, cnFields, filterPatch } = result.effects;

  if (consents.length) {
    const proseVersion = typeof result.answers?.proseVersion === 'string' ? result.answers.proseVersion : null;
    if (!proseVersion) throw new Error('applyCnStep: consent effects need the proseVersion answer');
    const record = deps.recordConsent ?? defaultRecordConsent;
    const given = deps.grantedConsents
      ? await deps.grantedConsents(userId, brand)
      : deps.recordConsent
        ? new Set<string>()
        : await defaultGrantedConsents(userId, brand);
    for (const c of consents) {
      if (c.granted && CN_ONCE_ONLY_CONSENTS.includes(c.type) && given.has(c.type)) {
        out.consentsAlreadyGiven++;
        continue;
      }
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
