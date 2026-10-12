// server/src/platform/brand/registry.ts — CANONICAL. Edit here, then `npm run gen:brand`.
//
// The product-brand registry (ARCHITECTURE.md §1.2, values from
// CN_TW_LAUNCH_PLAN.md §2.1, ids per TASK_PLAN.md R-01). One codebase serves
// two product brands, resolved per request from the Host header:
//   - RoboApply at roboapply.io (international, including Taiwan)
//   - GoApply   at goapply.top  (mainland China)
//
// Owner ruling D5 (GOAPPLY_PARITY_PLAN.md): both brands have the same
// functionality. A product flag that is on for RoboApply is on for GoApply.
// What differs follows from the market: job sources, language, currency,
// payment rails, sign-in methods beyond email + password, legal lines, and the
// market-specific data features (h1bHistory, eeoAnswers; campusCalendar,
// cn.referralCodes).
//
// Rules for this file (the mirror `lib/brand/registry.generated.ts` is a byte
// copy, compiled by Node, Next server, Next client and the proxy):
//   - ZERO imports and NO env reads. Env-dependent values (secrets, overrides,
//     legal numbers, credential checks) live in `runtime.ts` / `../flags.ts`.
//   - Pure data plus pure functions only.
//   - Never reuse APP_NAME / 'robohire' / 'gohire' here: those select the
//     recruiter bank and its database, not the product brand.
//   - D3: nothing here is a fabricated fact. Unknown legal values stay empty
//     and the UI shows them only when ops configures them.

export type BrandId = 'roboapply' | 'goapply';
export type Market = 'intl' | 'cn';
export type RoboLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'pt' | 'de';
export type AuthMethod = 'email_password' | 'google' | 'line' | 'phone_otp' | 'wechat';
export type PaymentRail = 'stripe' | 'alipay' | 'wechatpay';
export type JobProvider =
  | 'activejobs'
  | 'linkedin'
  | 'jsearch'
  | 'bank_robohire'
  | 'bank_gohire'
  | 'user_import';
export type LlmProfile = 'global' | 'domestic_cn';
export type HiringContactsMode = 'off' | 'deeplinks_only' | 'on';

/**
 * Static per-brand product flags (the registry layer of the capability
 * resolver). `server/src/platform/flags.ts` combines these with the
 * credential/env/mode checks, `FLAG_<BRAND>_<KEY>` env overrides and per-user
 * `RAEntitlementOverride` rows. Never read these directly to gate a feature;
 * call `isEnabled(key)` (server) or `useFlag(key)` (client).
 */
export interface BrandFlags {
  copilot: boolean;
  agent: boolean;
  extension: boolean;
  /** Coaching roster (also needs a non-empty roster to show in nav). */
  coaching: boolean;
  interviewBank: boolean;
  /** Voice practice. Both brands; the media plane comes from the `voice` env group (GoApply: own when CN_LIVEKIT_URL is set, else the shared one). */
  interviewVoice: boolean;
  /** ARCH name for the invite-friends programme; superseded by `invites` (F19). Resolved equal to `invites`. */
  referrals: boolean;
  webPush: boolean;
  /** Gated on a licensed people-data provider (D3). */
  contactEmailLookup: boolean;
  /** 'on' only after the RoboHire/GoHire opt-in UI ships (OPS-A10). */
  hiringContacts: HiringContactsMode;
  /** Gated on a licensed provider (D3). */
  companyFunding: boolean;
  /** US DOL LCA public data; RoboApply only. */
  h1bHistory: boolean;
  /** Campus calendar product surface (GoApply). The capability `jobs.campusCalendar` is the same switch; `CN_CAMPUS_CALENDAR_ENABLED=false` turns it off. */
  campusCalendar: boolean;
  /** EEO answers in the profile/autofill. False for GoApply. */
  eeoAnswers: boolean;
  /** RoboHire/GoHire recruiter → seeker invitations (deferred until the intake API exists). */
  invitations: boolean;
  /** Invite friends (F19). */
  invites: boolean;
  /** 内推码 hub (F19, GoApply V2). */
  'cn.referralCodes': boolean;
  /** Offer comparison view in the tracker. */
  offers: boolean;
  /** Logged-out assistant on public pages. */
  visitorAssistant: boolean;
  /** Authenticator-app two-factor sign-in. */
  totp: boolean;
  /** Student plans and verification. */
  student: boolean;
  /** Weekly competitiveness report. */
  competitiveness: boolean;
  /** Company news on the job page (Tavily search results, labelled as such; WP-34). Dark until the owner turns it on. */
  companyNews: boolean;
  /** Programmatic browse pages are live (`/browse/*`, WP-56); the marketing quick search links there (WP-40). */
  'seo.browse': boolean;
}

export interface ProductBrand {
  id: BrandId;
  market: Market;
  /** 'RoboApply' | 'GoApply' — substitutes %BRAND% in bundles. */
  name: string;
  /** Empty until the owner supplies it (D3); the footer renders it only when set (runtime env may provide it). */
  legalEntity: string;
  /** Production hosts, lowercase, no port. */
  hosts: string[];
  /** Local development hosts, lowercase, no port. */
  devHosts: string[];
  canonicalOrigin: string;
  /** Documented cookie domain. The session cookie uses `brandEnv(brand, 'COOKIE_DOMAIN')` (brand-own: never the other brand's value) and only on matching hosts. */
  cookieDomain: string;
  defaultLocale: RoboLocale;
  locales: RoboLocale[];
  seoLocales: RoboLocale[];
  defaultTimezone: string;
  /** ISO-3166 alpha-2. */
  defaultCountry: string;
  countries: string[];
  currency: 'USD' | 'CNY';
  paymentRails: PaymentRail[];
  /**
   * Methods the brand offers when configured, in display order; the resolver
   * drops unconfigured ones. Email + password is first on both brands. The
   * additional methods are a market difference.
   */
  authMethods: AuthMethod[];
  marketingOptInDefault: boolean;
  /**
   * The brand's job sources (the per-market difference D5 names). Adapters
   * registered for the market (`ats_public` employer boards) join this list in
   * the ingest layer.
   */
  jobProviders: JobProvider[];
  /**
   * The profile used when the brand has its OWN model provider. GoApply with
   * no CN_LLM_PROVIDER / CN_LLM_MODEL runs on the shared stack with the
   * `global` profile (the effective profile is resolved in the LLM layer).
   */
  llmProfile: LlmProfile;
  /** Prefix of the brand's optional override variables (`brandEnv`). */
  llmEnvPrefix: '' | 'CN_';
  interview: { agentName: string; envPrefix: '' | 'CN_' };
  email: {
    fromName: string;
    /** Default only; the email platform reads `brandEnv(brand, 'EMAIL_FROM')` first. */
    fromAddress: string;
    replyTo: string;
    /** The PREFERRED transport, used when its credentials are set. GoApply falls back to the shared Resend account (CN_EMAIL_TRANSPORT picks; `none` turns email off). */
    transport: 'resend' | 'aliyun_dm';
  };
  assets: { mark: string; logo: string; og: string; favicon: string; appleTouch: string };
  theme: { themeColorLight: string; themeColorDark: string };
  seo: { titleSuffix: string; sameAs: string[]; searchEngines: ('google' | 'bing' | 'baidu')[] };
  legal: {
    termsPath: string;
    privacyPath: string;
    /** Filing numbers come from runtime env (CN_ICP_NUMBER, CN_PSB_NUMBER); never hard-coded. */
    icpNumber?: string;
    psbNumber?: string;
    aiModelDisclosure?: boolean;
  };
  otherBrand: BrandId;
  flags: BrandFlags;
}

export const BRAND_IDS: readonly BrandId[] = ['roboapply', 'goapply'];

export const ALL_LOCALES: readonly RoboLocale[] = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];

export const BRANDS: Record<BrandId, ProductBrand> = {
  roboapply: {
    id: 'roboapply',
    market: 'intl',
    name: 'RoboApply',
    legalEntity: '',
    hosts: ['roboapply.io', 'www.roboapply.io', 'api.roboapply.io'],
    devHosts: ['localhost', '127.0.0.1'],
    canonicalOrigin: 'https://www.roboapply.io',
    cookieDomain: '.roboapply.io',
    defaultLocale: 'en',
    locales: ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'],
    seoLocales: ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'],
    defaultTimezone: 'UTC',
    defaultCountry: 'US',
    countries: ['US', 'CA', 'GB', 'AU', 'IE', 'NZ', 'SG', 'HK', 'TW', 'JP', 'KR', 'DE', 'FR', 'ES', 'PT'],
    currency: 'USD',
    paymentRails: ['stripe'],
    authMethods: ['email_password', 'google', 'line'],
    marketingOptInDefault: false,
    // `linkedin` is not a source: not subscribed and not to be (MARKET_STRATEGY M-4).
    jobProviders: ['activejobs', 'bank_robohire', 'jsearch', 'user_import'],
    llmProfile: 'global',
    llmEnvPrefix: '',
    interview: { agentName: 'RoboApply-Interview', envPrefix: '' },
    email: {
      fromName: 'RoboApply',
      fromAddress: 'noreply@roboapply.io',
      replyTo: 'support@roboapply.io',
      transport: 'resend',
    },
    assets: {
      mark: '/roboapply-mark.svg',
      logo: '/roboapply-logo.png',
      og: '/og.png',
      favicon: '/roboapply-mark.svg',
      appleTouch: '/roboapply-logo.png',
    },
    theme: { themeColorLight: '#FCFCFE', themeColorDark: '#171622' },
    seo: { titleSuffix: 'RoboApply', sameAs: [], searchEngines: ['google', 'bing'] },
    legal: { termsPath: '/legal/terms', privacyPath: '/legal/privacy' },
    otherBrand: 'goapply',
    flags: {
      copilot: true,
      agent: true,
      extension: true,
      coaching: true,
      interviewBank: true,
      interviewVoice: true,
      referrals: true,
      webPush: true,
      contactEmailLookup: false,
      hiringContacts: 'deeplinks_only',
      companyFunding: false,
      h1bHistory: true,
      campusCalendar: false,
      eeoAnswers: true,
      invitations: false,
      invites: true,
      'cn.referralCodes': false,
      offers: true,
      visitorAssistant: false, // off by default (TASK_PLAN WP-78); enable per environment with FLAG_ROBOAPPLY_VISITOR_ASSISTANT=true
      totp: true,
      student: true,
      competitiveness: true,
      companyNews: false,
      'seo.browse': false,
    },
  },
  goapply: {
    id: 'goapply',
    market: 'cn',
    name: 'GoApply',
    legalEntity: '',
    hosts: ['goapply.top', 'www.goapply.top'],
    devHosts: ['goapply.localhost'],
    canonicalOrigin: 'https://www.goapply.top',
    cookieDomain: '.goapply.top',
    defaultLocale: 'zh',
    locales: ['zh', 'en'],
    seoLocales: ['zh'],
    defaultTimezone: 'Asia/Shanghai',
    defaultCountry: 'CN',
    countries: ['CN'],
    currency: 'CNY',
    paymentRails: ['alipay', 'wechatpay'],
    // Email first, as on RoboApply. Phone and WeChat appear beside it when their
    // credentials exist. Google and LINE stay RoboApply-only (not reachable from
    // mainland networks): a market sign-in difference.
    authMethods: ['email_password', 'phone_otp', 'wechat'],
    marketingOptInDefault: false,
    // Mainland sources. Employer boards join through the market-registered
    // `ats_public` adapter. JSearch is not a GoApply source (MARKET_STRATEGY M-6).
    jobProviders: ['bank_gohire', 'user_import'],
    llmProfile: 'domestic_cn',
    llmEnvPrefix: 'CN_',
    interview: { agentName: 'GoApply-Interview', envPrefix: 'CN_' },
    email: {
      fromName: 'GoApply',
      fromAddress: 'noreply@goapply.top',
      replyTo: 'support@goapply.top',
      transport: 'aliyun_dm',
    },
    // Planned asset paths; the brand presentation WP (WP-12) adds the files.
    assets: {
      mark: '/brands/goapply/mark.svg',
      logo: '/brands/goapply/logo.png',
      og: '/brands/goapply/og.png',
      favicon: '/brands/goapply/favicon.svg',
      appleTouch: '/brands/goapply/apple-touch.png',
    },
    theme: { themeColorLight: '#FCFCFE', themeColorDark: '#171622' },
    seo: { titleSuffix: 'GoApply', sameAs: [], searchEngines: ['baidu', 'bing'] },
    legal: { termsPath: '/legal/terms', privacyPath: '/legal/privacy', aiModelDisclosure: true },
    otherBrand: 'roboapply',
    flags: {
      copilot: true,
      agent: true,
      extension: true,
      coaching: true,
      interviewBank: true,
      interviewVoice: true,
      referrals: true,
      webPush: true,
      contactEmailLookup: false,
      hiringContacts: 'deeplinks_only',
      companyFunding: false,
      h1bHistory: false,
      campusCalendar: true,
      eeoAnswers: false,
      invitations: false,
      invites: true,
      'cn.referralCodes': true,
      offers: true,
      visitorAssistant: false,
      totp: true,
      student: true,
      competitiveness: true,
      companyNews: false,
      'seo.browse': false,
    },
  },
};

export const DEFAULT_BRAND: BrandId = 'roboapply';

export function isBrandId(value: unknown): value is BrandId {
  return value === 'roboapply' || value === 'goapply';
}

/**
 * Accepts the canonical ids and the market aliases used in older notes and
 * the CN plan (`intl` → roboapply, `cn` → goapply). Returns null otherwise.
 */
export function parseBrandId(value: unknown): BrandId | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'roboapply' || v === 'intl') return 'roboapply';
  if (v === 'goapply' || v === 'cn') return 'goapply';
  return null;
}

export function getBrand(id: BrandId): ProductBrand {
  return BRANDS[id] ?? BRANDS[DEFAULT_BRAND];
}

/** Lowercase, trim, take the first value of a comma list, strip the port (IPv6-aware) and a trailing dot. */
export function normalizeHost(rawHost: string | null | undefined): string {
  if (!rawHost) return '';
  let host = String(rawHost).split(',')[0]!.trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end === -1 ? host : host.slice(0, end + 1);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** Pure: strip port, lowercase, exact host match (prod + dev hosts), then suffix match on prod hosts; null when unknown. */
export function brandIdFromHost(rawHost: string | null | undefined): BrandId | null {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  for (const id of BRAND_IDS) {
    const b = BRANDS[id];
    if (b.hosts.includes(host) || b.devHosts.includes(host)) return id;
  }
  for (const id of BRAND_IDS) {
    if (BRANDS[id].hosts.some((h) => host.endsWith(`.${h}`))) return id;
  }
  return null;
}

/** localhost, *.localhost, 127.0.0.1, [::1] and *.vercel.app preview hosts. */
export function isDevOrPreviewHost(rawHost: string | null | undefined): boolean {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.vercel.app')
  );
}

/** Narrow a requested locale to the brand's list, falling back to its default. */
export function clampLocaleToBrand(brand: ProductBrand, locale: string | null | undefined): RoboLocale {
  return locale && (brand.locales as string[]).includes(locale) ? (locale as RoboLocale) : brand.defaultLocale;
}
