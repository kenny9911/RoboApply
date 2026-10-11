// server/src/platform/flags.ts
//
// The one capability resolver (TASK_PLAN.md R-04; ARCHITECTURE.md §1.6
// "flags"; CN_TW_LAUNCH_PLAN.md §2.3 "capabilities"; requirements and defaults
// per owner ruling D5, GOAPPLY_PARITY_PLAN.md §3.2). Keys = ARCH BrandFlags
// ∪ CN §2.3 capability keys ∪ the plan's additions (invites,
// cn.referralCodes, hiringContacts, offers, visitorAssistant, totp, student,
// competitiveness).
//
//   enabled(key) = requirementsMet(key)                 ← credentials, off switches (cannot be overridden)
//                  AND (userOverride ?? envOverride ?? registryDefault)
//
// D5 (brand parity): a capability that is on for RoboApply is on for GoApply
// by default. A requirement is the credential the capability really needs, read
// through `brandEnv` (an optional CN_ override, else the shared stack). No
// requirement tests a China-only credential, a licence mode or a payments
// switch any more. What used to be a prerequisite survives as an OFF switch:
//   CN_RECRUITMENT_INFO_MODE=off        no GoApply job feed, recommendations or alerts
//   CN_CAMPUS_CALENDAR_ENABLED=false    no campus calendar
//   CN_EMAIL_TRANSPORT=none             no GoApply email (and no password reset)
//   CN_PAYMENTS_ENABLED=false           GoApply stops charging (both CN rails)
//   FLAG_GOAPPLY_<KEY>=false            any product switch
// Market-specific keys stay with their market: auth.google, auth.line,
// pay.stripe, fx.reference, h1bHistory, eeoAnswers (RoboApply); auth.phoneOtp,
// auth.wechat*, notify.wechat, cn.referralCodes, legal.footer.* (GoApply, each
// only when its own value is set).
//
//   - registryDefault: `brand.flags[key]` (true for pure capability keys,
//     whose applicability lives in their requirement: auth methods, rails…)
//   - envOverride:     FLAG_<BRAND>_<KEY>, e.g. FLAG_GOAPPLY_COACHING=true,
//                      FLAG_ROBOAPPLY_CN_REFERRAL_CODES=false (dots → '_',
//                      camelCase → SNAKE)
//   - userOverride:    a live `RAEntitlementOverride` row with key
//                      `flag:<key>` and a boolean value (per-user beta)
//
// A disabled feature has no UI entry; its router answers 404
// `feature_disabled` (`requireFlag`). A disabled AI capability answers 503
// `ai_unavailable`, and so does an AI-only product flag
// (`AI_DEPENDENT_FLAGS`) whose product switch is on but whose brand cannot run
// AI text (GoApply with an unusable content-safety filter).
//
// `campusCalendar` (ARCH product flag) and `jobs.campusCalendar` (CN §2.3
// capability) are ONE switch: both carry the same requirement and both resolve
// from the `campusCalendar` registry value and its overrides
// (FLAG_<BRAND>_CAMPUS_CALENDAR, `flag:campusCalendar`), so UI reading either
// key and the router gated on `jobs.campusCalendar` always agree. Nothing is
// simulated when a credential is missing: the capability is off.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getCurrentBrandOrDefault } from './brand/brandContext.js';
import { envSet, parseBoolEnv, brandEnv, type EnvSource } from './brand/brandEnv.js';
import type { BrandFlags, BrandId, HiringContactsMode, ProductBrand } from './brand/registry.js';
import { contentSafetyReadiness } from './llm/contentSafety/config.js';

/** Product flags held in the registry (booleans only; hiringContacts is a mode). */
export type ProductFlagKey = Exclude<keyof BrandFlags, 'hiringContacts'>;

export const CAPABILITY_KEYS = [
  'auth.phoneOtp',
  'auth.wechatWeb',
  'auth.wechatInApp',
  'auth.wechatMini',
  'auth.google',
  'auth.line',
  'auth.passwordReset',
  'pay.stripe',
  'pay.alipay',
  'pay.wechatpay',
  'ai.text',
  'ai.vision',
  'ai.interviewVoice',
  'jobs.feed',
  'jobs.recommendations',
  'jobs.campusCalendar',
  'jobs.import',
  'jobs.alerts',
  'notify.email',
  'notify.wechat',
  'fx.reference',
  'legal.footer.entity',
  'legal.footer.icp',
  'legal.footer.psb',
  'legal.footer.edi',
  'legal.footer.hrLicence',
  'legal.footer.genaiFiling',
  'legal.footer.aiDisclosure',
  'legal.footer.complaints',
  'ext.autofill',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const PRODUCT_FLAG_KEYS = [
  'copilot',
  'agent',
  'extension',
  'coaching',
  'interviewBank',
  'interviewVoice',
  'referrals',
  'webPush',
  'contactEmailLookup',
  'companyFunding',
  'h1bHistory',
  'campusCalendar',
  'eeoAnswers',
  'invitations',
  'invites',
  'cn.referralCodes',
  'offers',
  'visitorAssistant',
  'totp',
  'student',
  'competitiveness',
  'companyNews',
  'seo.browse',
] as const satisfies readonly ProductFlagKey[];

// Compile-time check: every boolean registry flag is listed above.
type UnlistedProductFlag = Exclude<ProductFlagKey, (typeof PRODUCT_FLAG_KEYS)[number]>;
const _allProductFlagsListed: UnlistedProductFlag extends never ? true : never = true;
void _allProductFlagsListed;

/** Every boolean key `isEnabled` accepts. */
export type FlagKey = ProductFlagKey | CapabilityKey;
export const FLAG_KEYS: readonly FlagKey[] = [...PRODUCT_FLAG_KEYS, ...CAPABILITY_KEYS];

export const HIRING_CONTACTS_MODES: readonly HiringContactsMode[] = ['off', 'deeplinks_only', 'on'];

/** The resolved map returned by `/api/v1/public/brand` and (via WP-10) `/auth/me`. */
export type ResolvedFlags = Record<FlagKey, boolean> & { hiringContacts: HiringContactsMode };

export type CnRecruitmentInfoMode = 'off' | 'partner_deeplink' | 'licensed';

/**
 * `CN_RECRUITMENT_INFO_MODE`: how GoApply shows recruitment information.
 * Unset (or any unknown value) is `licensed`: the feed is on by default (D5).
 * `partner_deeplink` when set. `off` only when the value is literally `off`:
 * it is the operator's off switch, never the result of a missing value.
 */
export function cnRecruitmentInfoMode(env: EnvSource = process.env): CnRecruitmentInfoMode {
  const v = (env.CN_RECRUITMENT_INFO_MODE || '').trim().toLowerCase();
  if (v === 'off') return 'off';
  return v === 'partner_deeplink' ? 'partner_deeplink' : 'licensed';
}

const CN_RECRUITMENT_INFO_MODES: readonly string[] = ['off', 'partner_deeplink', 'licensed'] satisfies readonly CnRecruitmentInfoMode[];

/**
 * The raw `CN_RECRUITMENT_INFO_MODE` when it is set and is not one of
 * `off | partner_deeplink | licensed`, else null. An unknown value is read as
 * `licensed` (above), so `CN_RECRUITMENT_INFO_MODE=false` leaves the job feed
 * ON although the operator meant to close it. The sibling switches accept
 * false/0/no/off; this one is a mode, and only the word `off` closes it. Startup
 * logs the value returned here so the mistake is never silent.
 */
export function cnRecruitmentInfoModeProblem(env: EnvSource = process.env): string | null {
  const raw = (env.CN_RECRUITMENT_INFO_MODE ?? '').trim();
  if (!raw) return null;
  return CN_RECRUITMENT_INFO_MODES.includes(raw.toLowerCase()) ? null : raw;
}

/** An off switch: the variable is set and does not parse as true. Unset or blank is not "off". */
function switchedOff(env: EnvSource, name: string): boolean {
  const raw = env[name];
  return typeof raw === 'string' && raw.trim() !== '' && !parseBoolEnv(raw);
}

function isProduction(env: EnvSource): boolean {
  return env.NODE_ENV === 'production';
}

function smsConfigured(env: EnvSource): boolean {
  const provider = (env.CN_SMS_PROVIDER || '').trim().toLowerCase();
  if (provider === 'aliyun') {
    return envSet(env, 'ALIYUN_SMS_ACCESS_KEY_ID', 'ALIYUN_SMS_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_OTP');
  }
  if (provider === 'tencent') {
    return envSet(env, 'TENCENT_SMS_SECRET_ID', 'TENCENT_SMS_SECRET_KEY', 'TENCENT_SMS_SDK_APP_ID', 'TENCENT_SMS_SIGN_NAME', 'TENCENT_SMS_TEMPLATE_OTP');
  }
  // Local development only: codes are printed to the server console.
  return !isProduction(env) && parseBoolEnv(env.SMS_DEV_CONSOLE);
}

/**
 * The brand can send email. RoboApply: Resend. GoApply: `CN_EMAIL_TRANSPORT`
 * picks the transport. `aliyun_dm` needs the three Aliyun DirectMail keys,
 * `none` is the off switch, and anything else (unset, `resend`) is the shared
 * Resend account. No `CN_EMAIL_FROM` is required: the email platform falls back
 * to the shared verified sender with GoApply's display name.
 */
function emailConfigured(brand: ProductBrand, env: EnvSource): boolean {
  if (brand.market !== 'cn') return envSet(env, 'RESEND_API_KEY');
  const transport = (env.CN_EMAIL_TRANSPORT || '').trim().toLowerCase();
  if (transport === 'aliyun_dm') {
    return envSet(env, 'ALIYUN_DM_ACCESS_KEY_ID', 'ALIYUN_DM_ACCESS_KEY_SECRET', 'ALIYUN_DM_ACCOUNT_NAME');
  }
  if (transport === 'none') return false;
  return envSet(env, 'RESEND_API_KEY');
}

/**
 * The VAPID key pair plus a contact subject the push services accept
 * (`mailto:` or `https://`). The same rule as `vapidConfig` in
 * features/push/config.ts, which the routes and the worker use: with the pair
 * set and the subject missing they answer "not configured", so the flag must
 * not offer push then. Both brands: GoApply reads the `push` group through
 * `brandEnv` (its own CN_VAPID_* set when CN_VAPID_PUBLIC_KEY is set, else the
 * shared pair).
 */
function vapidUsable(brand: ProductBrand, env: EnvSource): boolean {
  const publicKey = brandEnv(brand, 'VAPID_PUBLIC_KEY', env)?.trim();
  const privateKey = brandEnv(brand, 'VAPID_PRIVATE_KEY', env)?.trim();
  const subject = brandEnv(brand, 'VAPID_SUBJECT', env)?.trim();
  return Boolean(publicKey && privateKey && subject && /^(mailto:|https:\/\/)/i.test(subject));
}

/**
 * The GoApply payments kill switch: `CN_PAYMENTS_ENABLED` is set and parses
 * false. Unset means on (D5): the variable is no longer a prerequisite.
 */
export function cnPaymentsKilled(env: EnvSource = process.env): boolean {
  return switchedOff(env, 'CN_PAYMENTS_ENABLED');
}

function aiTextConfigured(brand: ProductBrand, env: EnvSource): boolean {
  // Both brands run on a text model by default: RoboApply on the shared stack
  // (unprefixed env + DB override, resolved by LLMService), GoApply on its own
  // domestic model when one is set and on the shared stack otherwise (D5). So
  // no model credential is tested here. GoApply calls also pass a
  // content-safety filter (WP-24), on the shared route too: an unusable filter
  // hides the AI features instead of letting every call fail closed with 503.
  return brand.market === 'cn' ? contentSafetyReadiness(env).usable : true;
}

// ── Requirement probes ──────────────────────────────────────────────────────
//
// Two requirements are owned by another module:
//   `ai.interviewVoice`  voiceAvailable(brand)      interview-engine/providers
//   `pay.wechatpay`      wechatPayReadiness(brand)  platform/billing/rails/wechatpay
// Importing either here would pull its module graph (the database pool and
// the LiveKit SDK; the server logger and the billing rails) into this file,
// which pure code and the web test helpers import. So `platform/startup.ts`
// registers both at boot, and until then (unit tests, tools) the same rule is
// evaluated here from the env table. flags.test.ts runs both against the
// real functions over a matrix of configurations, so they cannot drift.

/** `voiceAvailable` reads `process.env`, so it answers only calls made with it. */
export type VoiceAvailabilityProbe = (brand: BrandId) => boolean;
/** `wechatPayReadiness(brand, env).ready`. */
export type WechatPayReadinessProbe = (brand: ProductBrand, env: EnvSource) => boolean;

let voiceProbe: VoiceAvailabilityProbe | null = null;
let wechatPayProbe: WechatPayReadinessProbe | null = null;

/** Register `voiceAvailable` (pass null to restore the built-in rule). */
export function setVoiceAvailabilityProbe(probe: VoiceAvailabilityProbe | null): void {
  voiceProbe = probe;
}

/** Register `wechatPayReadiness` (pass null to restore the built-in rule). */
export function setWechatPayReadinessProbe(probe: WechatPayReadinessProbe | null): void {
  wechatPayProbe = probe;
}

/** VOICE_PROVIDER / CN_VOICE_PROVIDER ids (interview-engine/config.ts VOICE_PROVIDER_IDS). */
const VOICE_PROVIDER_IDS = ['livekit_cloud', 'livekit_selfhosted', 'volcano', 'trtc'] as const;
/** Ids with an implementation (interview-engine/providers IMPLEMENTED_VOICE_PROVIDERS). */
const IMPLEMENTED_VOICE_PROVIDER_IDS: readonly string[] = ['livekit_cloud', 'livekit_selfhosted'];

/**
 * The brand's selected voice provider has an implementation and its credentials
 * are set. Every name is in the `voice` group of `brandEnv`, so GoApply uses
 * its own plane when CN_LIVEKIT_URL is set and the shared LiveKit project
 * otherwise, never a mix of the two.
 */
function voiceMediaAvailable(brand: ProductBrand, env: EnvSource): boolean {
  if (voiceProbe && env === process.env) return voiceProbe(brand.id);
  const raw = (brandEnv(brand, 'VOICE_PROVIDER', env) || '').toLowerCase();
  const id = (VOICE_PROVIDER_IDS as readonly string[]).includes(raw) ? raw : 'livekit_cloud';
  if (!IMPLEMENTED_VOICE_PROVIDER_IDS.includes(id)) return false;
  return Boolean(brandEnv(brand, 'LIVEKIT_URL', env) && brandEnv(brand, 'LIVEKIT_API_KEY', env) && brandEnv(brand, 'LIVEKIT_API_SECRET', env));
}

/** A PEM from env with surrounding quotes and literal "\n" escapes resolved (as the rail reads it). */
function pemSet(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').trim().length > 0;
}

/** Legal names compare without case, bracket width or whitespace. */
function entityKey(name: string | undefined): string {
  return (name ?? '').normalize('NFKC').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/\s+/g, '').toLowerCase();
}

/**
 * WeChat Pay may take money: merchant credentials, a 32-byte APIv3 key, the
 * WeChat Pay public key + id that verify notifies, and the collecting entity
 * (CN_PAYMENT_COLLECTING_ENTITY) equal to the merchant's registered legal
 * name (WECHATPAY_MERCHANT_ENTITY) — collecting for another seller is 二清
 * (OPS C-13).
 */
function wechatPayReady(brand: ProductBrand, env: EnvSource): boolean {
  if (wechatPayProbe) return wechatPayProbe(brand, env);
  if (brand.market !== 'cn' || !brand.paymentRails.includes('wechatpay')) return false;
  if (!envSet(env, 'WECHATPAY_MCH_ID', 'WECHATPAY_APP_ID', 'WECHATPAY_MCH_CERT_SERIAL', 'WECHATPAY_PUBLIC_KEY_ID')) return false;
  if (!pemSet(env.WECHATPAY_MCH_PRIVATE_KEY) || !pemSet(env.WECHATPAY_PUBLIC_KEY)) return false;
  if (Buffer.byteLength((env.WECHATPAY_API_V3_KEY ?? '').trim(), 'utf8') !== 32) return false;
  const entity = brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env)?.trim();
  const merchant = (env.WECHATPAY_MERCHANT_ENTITY ?? '').trim();
  if (!entity || !merchant) return false;
  return entityKey(merchant) === entityKey(entity);
}

/**
 * Product flags whose surface is LLM-only: they carry the `ai.text`
 * requirement, so when a brand cannot run AI text they are hidden and their
 * routes answer 503 `ai_unavailable`.
 */
export const AI_DEPENDENT_FLAGS: ReadonlySet<FlagKey> = new Set<FlagKey>(['copilot', 'agent', 'visitorAssistant', 'competitiveness']);

/**
 * Campus calendar requirement, shared by `campusCalendar` and
 * `jobs.campusCalendar`: the brand has the surface (registry value), and on
 * GoApply `CN_CAMPUS_CALENDAR_ENABLED=false` is the off switch. It no longer
 * depends on the recruitment-info mode.
 */
function campusCalendarAllowed(brand: ProductBrand, env: EnvSource): boolean {
  if (!brand.flags.campusCalendar) return false;
  return brand.market === 'cn' ? !switchedOff(env, 'CN_CAMPUS_CALENDAR_ENABLED') : true;
}

/** `jobs.campusCalendar` is an alias: it resolves exactly as `campusCalendar`. */
function canonicalKey(key: FlagKey): FlagKey {
  return key === 'jobs.campusCalendar' ? 'campusCalendar' : key;
}

/**
 * Requirement checks that no override can bypass: credentials, operator off
 * switches and brand applicability. Product flags without a requirement return true.
 */
export function requirementsMet(key: FlagKey, brand: ProductBrand, env: EnvSource = process.env): boolean {
  const cn = brand.market === 'cn';
  const mode = cnRecruitmentInfoMode(env);
  switch (key) {
    // ── auth ──────────────────────────────────────────────────────────────
    case 'auth.google':
      return brand.authMethods.includes('google') && envSet(env, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
    case 'auth.line':
      return brand.authMethods.includes('line') && envSet(env, 'LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET');
    case 'auth.phoneOtp':
      return brand.authMethods.includes('phone_otp') && smsConfigured(env);
    case 'auth.wechatWeb':
      return brand.authMethods.includes('wechat') && envSet(env, 'WECHAT_OPEN_APP_ID', 'WECHAT_OPEN_APP_SECRET');
    case 'auth.wechatInApp':
      return brand.authMethods.includes('wechat') && envSet(env, 'WECHAT_MP_APP_ID', 'WECHAT_MP_APP_SECRET');
    case 'auth.wechatMini':
      return brand.authMethods.includes('wechat') && envSet(env, 'WECHAT_MINI_APP_ID', 'WECHAT_MINI_APP_SECRET');
    case 'auth.passwordReset':
      return brand.authMethods.includes('email_password') && emailConfigured(brand, env);
    // ── payments (brand-locked rails; D6) ───────────────────────────────
    case 'pay.stripe':
      return brand.paymentRails.includes('stripe') && envSet(env, 'STRIPE_SECRET_KEY');
    case 'pay.alipay':
      // The rail's own credential is the callback secret, the equal of
      // STRIPE_SECRET_KEY (it is what refuses a forged notify). The worker URL
      // has a default in the rail, so ALIPAY_API_URL is not required.
      // Under the operator's hard gate (CN_PAYMENT_REQUIRE_ENTITY=true, off by
      // default) the rail refuses to charge until the collecting entity is
      // named; the capability says the same, so the public brand payload never
      // lists a rail that `GET /billing/plans` does not offer (PAR gate).
      return (
        brand.paymentRails.includes('alipay') &&
        !cnPaymentsKilled(env) &&
        envSet(env, 'ALIPAY_CALLBACK_SECRET') &&
        !(parseBoolEnv(env.CN_PAYMENT_REQUIRE_ENTITY) && !brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env)?.trim())
      );
    case 'pay.wechatpay':
      // Merchant credentials, the WeChat Pay public key + id that verify
      // notifies, and the collecting entity matching the merchant's legal name
      // (`wechatPayReadiness`, OPS C-13). CN_PAYMENTS_ENABLED=false stops it.
      return (
        brand.paymentRails.includes('wechatpay') &&
        !cnPaymentsKilled(env) &&
        envSet(
          env,
          'WECHATPAY_MCH_ID',
          'WECHATPAY_APP_ID',
          'WECHATPAY_API_V3_KEY',
          'WECHATPAY_MCH_CERT_SERIAL',
          'WECHATPAY_MCH_PRIVATE_KEY',
          'WECHATPAY_PUBLIC_KEY',
          'WECHATPAY_PUBLIC_KEY_ID',
        ) &&
        wechatPayReady(brand, env)
      );
    // ── AI ───────────────────────────────────────────────────────────────
    case 'ai.text':
      return aiTextConfigured(brand, env);
    case 'ai.vision':
      // Same as `ai.text`: the vision model falls back to the shared stack.
      return aiTextConfigured(brand, env);
    case 'ai.interviewVoice':
      // The media plane only. Whether the product offers voice is the
      // `interviewVoice` switch (registry default, FLAG_<BRAND>_INTERVIEW_VOICE,
      // per-user override), applied in `isEnabledForBrand`.
      return voiceMediaAvailable(brand, env);
    // ── jobs (on by default; CN_RECRUITMENT_INFO_MODE=off is the off switch) ──
    case 'jobs.feed':
    case 'jobs.recommendations':
    case 'jobs.alerts':
      return cn ? mode !== 'off' : true;
    case 'jobs.campusCalendar':
    case 'campusCalendar':
      return campusCalendarAllowed(brand, env);
    case 'jobs.import':
      return true;
    // ── notifications ────────────────────────────────────────────────────
    case 'notify.email':
      return emailConfigured(brand, env);
    case 'notify.wechat':
      return cn && envSet(env, 'WECHAT_MP_APP_ID', 'WECHAT_MP_APP_SECRET', 'WECHAT_MP_TOKEN');
    // ── money display ────────────────────────────────────────────────────
    case 'fx.reference':
      // TWD reference line (R-25). The rate itself is AppConfig `fx.reference`;
      // WP-21a/21b hide the line when no rate is stored.
      return !cn;
    // ── legal footer (each line only when set; D3) ───────────────────────
    case 'legal.footer.entity':
      return Boolean(brandEnv(brand, 'LEGAL_ENTITY_NAME', env));
    case 'legal.footer.icp':
      return cn && envSet(env, 'CN_ICP_NUMBER');
    case 'legal.footer.psb':
      return cn && envSet(env, 'CN_PSB_NUMBER');
    case 'legal.footer.edi':
      return cn && envSet(env, 'CN_EDI_LICENCE_NUMBER');
    case 'legal.footer.hrLicence':
      return cn && envSet(env, 'CN_HR_LICENCE_NUMBER', 'CN_HR_LICENCE_HOLDER');
    case 'legal.footer.genaiFiling':
      return cn && (envSet(env, 'CN_GENAI_APP_REGISTRATION_NO') || envSet(env, 'CN_GENAI_DISCLOSURES'));
    case 'legal.footer.aiDisclosure':
      // The model line shows whenever the brand's AI runs (CN plan §5.3).
      return Boolean(brand.legal.aiModelDisclosure) && aiTextConfigured(brand, env);
    case 'legal.footer.complaints':
      return cn && (envSet(env, 'CN_COMPLAINT_EMAIL') || envSet(env, 'CN_COMPLAINT_PHONE'));
    // ── extension ────────────────────────────────────────────────────────
    case 'ext.autofill':
      return true; // gated by the `extension` product flag below
    // ── web push (WP-61) ─────────────────────────────────────────────────
    case 'webPush':
      // Both brands, and only with a usable VAPID config: without it nothing
      // could be delivered.
      return vapidUsable(brand, env);
    // ── AI-only product surfaces ─────────────────────────────────────────
    case 'copilot':
    case 'agent':
    case 'visitorAssistant':
    case 'competitiveness':
      return aiTextConfigured(brand, env);
    default:
      return true;
  }
}

/** Default before overrides: the registry value for product flags, true for capability keys. */
function registryDefault(key: FlagKey, brand: ProductBrand): boolean {
  if (key === 'referrals') return brand.flags.invites;
  if (key === 'ext.autofill') return brand.flags.extension;
  if ((PRODUCT_FLAG_KEYS as readonly string[]).includes(key)) {
    return Boolean(brand.flags[key as ProductFlagKey]);
  }
  return true;
}

/** `FLAG_<BRAND>_<KEY>`: `cn.referralCodes` → FLAG_GOAPPLY_CN_REFERRAL_CODES. */
export function flagEnvName(brandId: BrandId, key: FlagKey | 'hiringContacts'): string {
  const snake = key
    .replace(/\./g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
  return `FLAG_${brandId.toUpperCase()}_${snake}`;
}

function envOverride(key: FlagKey, brand: ProductBrand, env: EnvSource): boolean | undefined {
  // `referrals` mirrors `invites` (F19), including its override.
  const effective: FlagKey = key === 'referrals' ? 'invites' : key;
  const raw = env[flagEnvName(brand.id, effective)];
  if (raw === undefined || raw.trim() === '') return undefined;
  return parseBoolEnv(raw);
}

/** Per-user overrides: `flag:<key>` → boolean or (for hiringContacts) mode. */
export type UserFlagOverrides = Partial<Record<FlagKey, boolean>> & { hiringContacts?: HiringContactsMode };

/** Sync resolution for one key (no per-user override). */
export function isEnabledForBrand(
  key: FlagKey,
  brand: ProductBrand = getCurrentBrandOrDefault(),
  env: EnvSource = process.env,
  userOverrides: UserFlagOverrides = {},
): boolean {
  if (!requirementsMet(key, brand, env)) return false;
  // The AI and voice capabilities also need their product switch.
  if (key === 'ai.interviewVoice' && !resolveBool('interviewVoice', brand, env, userOverrides)) return false;
  return resolveBool(canonicalKey(key), brand, env, userOverrides);
}

/**
 * True when an AI-dependent product flag is off ONLY because the brand cannot
 * run AI text: its product switch (registry/env/user override) is on. Used by
 * `requireFlag` to answer 503 `ai_unavailable` instead of 404.
 */
export function offOnlyForAi(key: FlagKey, brand: ProductBrand, env: EnvSource, userOverrides: UserFlagOverrides = {}): boolean {
  if (!AI_DEPENDENT_FLAGS.has(key) || aiTextConfigured(brand, env)) return false;
  return resolveBool(key, brand, env, userOverrides);
}

function resolveBool(key: FlagKey, brand: ProductBrand, env: EnvSource, userOverrides: UserFlagOverrides): boolean {
  const lookup: FlagKey = key === 'referrals' ? 'invites' : key === 'ext.autofill' ? 'extension' : key;
  const user = userOverrides[key] ?? userOverrides[lookup];
  if (typeof user === 'boolean') return user;
  const fromEnv = envOverride(key, brand, env) ?? (lookup !== key ? envOverride(lookup, brand, env) : undefined);
  if (fromEnv !== undefined) return fromEnv;
  return registryDefault(key, brand);
}

export function parseHiringContactsMode(value: unknown): HiringContactsMode | null {
  return typeof value === 'string' && (HIRING_CONTACTS_MODES as readonly string[]).includes(value)
    ? (value as HiringContactsMode)
    : null;
}

/** H15: `off | deeplinks_only | on`, default `deeplinks_only`; env FLAG_<BRAND>_HIRING_CONTACTS. */
export function hiringContactsMode(
  brand: ProductBrand = getCurrentBrandOrDefault(),
  env: EnvSource = process.env,
  userOverrides: UserFlagOverrides = {},
): HiringContactsMode {
  return (
    userOverrides.hiringContacts ??
    parseHiringContactsMode(env[flagEnvName(brand.id, 'hiringContacts')]?.trim()) ??
    brand.flags.hiringContacts
  );
}

/** Every key resolved for a brand (no user). Used by GET /api/v1/public/brand. */
export function resolveFlags(
  brand: ProductBrand = getCurrentBrandOrDefault(),
  env: EnvSource = process.env,
  userOverrides: UserFlagOverrides = {},
): ResolvedFlags {
  const out = {} as Record<FlagKey, boolean>;
  for (const key of FLAG_KEYS) out[key] = isEnabledForBrand(key, brand, env, userOverrides);
  return { ...out, hiringContacts: hiringContactsMode(brand, env, userOverrides) };
}

// ── Per-user overrides (RAEntitlementOverride, key `flag:<key>`) ──────────

export interface FlagOverrideRow {
  key: string;
  value: unknown;
  expiresAt: Date | null;
  createdAt: Date;
}

export type FlagOverrideLoader = (userId: string) => Promise<FlagOverrideRow[]>;

const defaultLoader: FlagOverrideLoader = async (userId) => {
  const { default: prisma } = await import('../lib/prisma.js');
  return prisma.rAEntitlementOverride.findMany({
    where: { userId, key: { startsWith: 'flag:' } },
    select: { key: true, value: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
};

let overrideLoader: FlagOverrideLoader = defaultLoader;

/** Test seam: replace the override loader (pass null to restore the Prisma one). */
export function setFlagOverrideLoader(loader: FlagOverrideLoader | null): void {
  overrideLoader = loader ?? defaultLoader;
}

/** Pure: newest live row per key wins; expired rows and non-matching values are ignored. */
export function overridesFromRows(rows: FlagOverrideRow[], now: Date = new Date()): UserFlagOverrides {
  const out: UserFlagOverrides = {};
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const row of sorted) {
    if (!row.key.startsWith('flag:')) continue;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue;
    const key = row.key.slice('flag:'.length);
    if (key === 'hiringContacts') {
      const mode = parseHiringContactsMode(row.value);
      if (mode) out.hiringContacts = mode;
      continue;
    }
    if ((FLAG_KEYS as readonly string[]).includes(key) && typeof row.value === 'boolean') {
      out[key as FlagKey] = row.value;
    }
  }
  return out;
}

export async function loadUserFlagOverrides(userId: string | null | undefined): Promise<UserFlagOverrides> {
  if (!userId) return {};
  try {
    return overridesFromRows(await overrideLoader(userId));
  } catch {
    // Overrides are a beta convenience; a failed lookup falls back to brand defaults.
    return {};
  }
}

export interface IsEnabledOptions {
  userId?: string | null;
  brand?: ProductBrand;
  env?: EnvSource;
}

/** R-04 `isEnabled(key)`: registry AND requirements AND per-user override. */
export async function isEnabled(key: FlagKey, options: IsEnabledOptions = {}): Promise<boolean> {
  const brand = options.brand ?? getCurrentBrandOrDefault();
  const env = options.env ?? process.env;
  if (!requirementsMet(key, brand, env)) return false;
  const overrides = await loadUserFlagOverrides(options.userId);
  return isEnabledForBrand(key, brand, env, overrides);
}

/** Resolved flags for a signed-in user (for `/auth/me`, WP-10). */
export async function resolveFlagsForUser(
  userId: string | null | undefined,
  options: { brand?: ProductBrand; env?: EnvSource } = {},
): Promise<ResolvedFlags> {
  const brand = options.brand ?? getCurrentBrandOrDefault();
  const env = options.env ?? process.env;
  return resolveFlags(brand, env, await loadUserFlagOverrides(userId));
}

export function isAiCapability(key: FlagKey): boolean {
  return key.startsWith('ai.');
}

/**
 * Per-route gate (never `router.use(requireFlag)` on a shared prefix).
 * Disabled → 404 `feature_disabled`; disabled AI capability → 503 `ai_unavailable`.
 * Place it after requireAuth so per-user overrides apply.
 */
export function requireFlag(key: FlagKey, options: { env?: EnvSource } = {}): RequestHandler {
  return async function flagGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as Request & { user?: { id?: string } }).user?.id ?? null;
      const brand = (req as Request & { brand?: ProductBrand }).brand ?? getCurrentBrandOrDefault();
      const env = options.env ?? process.env;
      const on = await isEnabled(key, { userId, brand, env });
      if (on) {
        next();
        return;
      }
      if (isAiCapability(key) || (AI_DEPENDENT_FLAGS.has(key) && offOnlyForAi(key, brand, env, await loadUserFlagOverrides(userId)))) {
        res.status(503).json({ success: false, code: 'ai_unavailable', error: 'This AI feature is not available right now.' });
        return;
      }
      res.status(404).json({ success: false, code: 'feature_disabled', error: 'This feature is not available.' });
    } catch (err) {
      next(err);
    }
  };
}
