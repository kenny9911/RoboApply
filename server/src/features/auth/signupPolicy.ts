// server/src/features/auth/signupPolicy.ts
//
// Pure signup rules (WP-10; PRODUCT_PLAN.md O0; CN_TW_LAUNCH_PLAN.md §4 intl
// signup; ARCHITECTURE.md §1.10). No I/O: SeekerAuthService and the OAuth
// account creation both call these, so every way into an account obeys them.
//
//   - Consents: every type must be a known one; `age_16_plus` is required on
//     both brands (H29); on RoboApply a zh-TW visitor or a visitor from Taiwan
//     must also accept the PDPA notice (`tw_pdpa_notice`).
//   - Marketing opt-in is unchecked by default and recorded as
//     `marketing_email` with the user's actual choice.
//   - Password: ≥8 characters with at least one letter and one digit.
//   - Market: GoApply → 'cn'; RoboApply → 'tw' / 'jp' / 'other' from the
//     locale the visitor used, never from Accept-Language.

import type { BrandId } from '../../platform/brand/registry.js';
import { isSeekerConsentType, type SeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import type { OnboardingEntry } from '../onboarding/contract.js';
import type { Touch } from '../growth/contract.js';
import { REQUIRED_SIGNUP_CONSENTS } from './contract.js';
import { authErrors } from './errors.js';

export interface SignupConsentInput {
  type: string;
  granted: boolean;
  proseVersion: string;
  /**
   * GoApply email signup: the hash of the consent text the form showed
   * (`prose.hash` from GET /auth/phone/policy). The server stores a hash only
   * when it equals the hash of a text it serves (features/auth/goapplySignup.ts).
   */
  proseHash?: string;
}

export interface ConsentRow {
  consentType: SeekerConsentType;
  granted: boolean;
  proseVersion: string;
  /** sha256 of the prose the server was serving (compliance catalog); absent for rows without catalog prose. */
  proseHash?: string | null;
}

export interface SignupAttributionInput {
  from?: string;
  jobId?: string;
  action?: 'apply';
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  alert?: string;
  anonId?: string;
  landingPath?: string;
}

/** Prose version recorded for the marketing opt-in row written from the signup checkbox. */
export const MARKETING_OPT_IN_PROSE_VERSION = '2026-10-10.signup.v1';

/** True when the PDPA notice applies: RoboApply and (locale zh-TW or country TW). */
export function pdpaNoticeRequired(brand: BrandId, locale: string | null | undefined, country: string | null | undefined): boolean {
  if (brand !== 'roboapply') return false;
  return locale === 'zh-TW' || (country ?? '').toUpperCase() === 'TW';
}

/**
 * Validate the signup consents and return the rows to write. Throws
 * `unknown_consent`, `age_consent_required` or `pdpa_consent_required` (422).
 */
export function validateSignupConsents(input: {
  brand: BrandId;
  consents: readonly SignupConsentInput[] | undefined;
  marketingOptIn?: boolean;
  locale?: string | null;
  country?: string | null;
}): ConsentRow[] {
  const consents = input.consents ?? [];
  const latest = new Map<SeekerConsentType, ConsentRow>();
  for (const c of consents) {
    if (!isSeekerConsentType(c.type)) throw authErrors.unknownConsent(c.type);
    latest.set(c.type, { consentType: c.type, granted: c.granted === true, proseVersion: c.proseVersion });
  }
  for (const required of REQUIRED_SIGNUP_CONSENTS) {
    if (latest.get(required)?.granted !== true) throw authErrors.ageConsentRequired();
  }
  if (pdpaNoticeRequired(input.brand, input.locale, input.country) && latest.get('tw_pdpa_notice')?.granted !== true) {
    throw authErrors.pdpaConsentRequired();
  }
  // The checkbox is the source of truth for marketing mail; a duplicate in
  // `consents` is replaced by it.
  latest.set('marketing_email', {
    consentType: 'marketing_email',
    granted: input.marketingOptIn === true,
    proseVersion: latest.get('marketing_email')?.proseVersion ?? MARKETING_OPT_IN_PROSE_VERSION,
  });
  return [...latest.values()];
}

const LETTER = /[A-Za-z]/;
const DIGIT = /\d/;

export function isStrongEnoughPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200 && LETTER.test(password) && DIGIT.test(password);
}

export function assertPassword(password: unknown): asserts password is string {
  if (!isStrongEnoughPassword(password)) throw authErrors.weakPassword();
}

/** `User.market` from the brand and the locale the visitor chose (ARCH §1.10). */
export function marketForSignup(brand: BrandId, locale: string | null | undefined): 'cn' | 'tw' | 'jp' | 'other' {
  if (brand === 'goapply') return 'cn';
  if (locale === 'zh-TW') return 'tw';
  if (locale === 'ja') return 'jp';
  return 'other';
}

function clean(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().slice(0, max);
  return v ? v : undefined;
}

/** `SeekerProfile.onboardingEntry` (F-ONB-02) from the signup attribution; null when nothing was carried. */
export function onboardingEntryFrom(attr: SignupAttributionInput | undefined): OnboardingEntry | null {
  if (!attr) return null;
  const entry: OnboardingEntry = {};
  const from = clean(attr.from, 80);
  if (from) entry.from = from;
  const jobId = clean(attr.jobId, 64);
  if (jobId) entry.jobId = jobId;
  if (attr.action === 'apply') entry.action = 'apply';
  const ref = clean(attr.ref, 64);
  if (ref) entry.ref = ref;
  const utmSource = clean(attr.utmSource, 120);
  if (utmSource) entry.utmSource = utmSource;
  const utmMedium = clean(attr.utmMedium, 120);
  if (utmMedium) entry.utmMedium = utmMedium;
  const utmCampaign = clean(attr.utmCampaign, 120);
  if (utmCampaign) entry.utmCampaign = utmCampaign;
  const alert = clean(attr.alert, 200);
  if (alert) entry.alert = alert;
  return Object.keys(entry).length ? entry : null;
}

/** First touch for `growth.recordAttribution` (WP-23 seam). */
export function touchFrom(attr: SignupAttributionInput | undefined, now: Date): Touch | null {
  const entry = onboardingEntryFrom(attr);
  const landingPath = clean(attr?.landingPath, 512);
  if (!entry && !landingPath) return null;
  const touch: Touch = { at: now.toISOString() };
  if (entry?.from) touch.from = entry.from;
  if (entry?.utmSource) touch.utmSource = entry.utmSource;
  if (entry?.utmMedium) touch.utmMedium = entry.utmMedium;
  if (entry?.utmCampaign) touch.utmCampaign = entry.utmCampaign;
  if (entry?.ref) touch.ref = entry.ref;
  if (entry?.jobId) touch.jobId = entry.jobId;
  if (entry?.action) touch.action = entry.action;
  if (entry?.alert) touch.alert = entry.alert;
  if (landingPath) touch.landingPath = landingPath;
  return touch;
}

/** IANA zone check (signup sends the browser's zone). */
export function safeTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
