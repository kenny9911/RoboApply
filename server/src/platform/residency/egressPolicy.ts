// server/src/platform/residency/egressPolicy.ts
//
// Which outside hosts may receive personal information (PI), per brand
// (CN_TW_LAUNCH_PLAN.md WP-RESIDENCY "Egress policy", §6.3; TASK_PLAN.md WP-15).
// Model endpoints have their own, finer rule in `platform/llm/brandPolicy.ts`
// (WP-14); this module reuses its mainland host list so the two never drift.
//
// GoApply — an ALLOWLIST. PI may go only to:
//   - domestic model hosts (deepseek, DashScope, Moonshot, Zhipu, Volcano Ark,
//     MiniMax China, plus `CN_LLM_DOMESTIC_HOSTS`);
//   - the GoHire parse API (`*.gohire.top`);
//   - mainland object storage only: Aliyun OSS `oss-cn-*`, Tencent COS
//     mainland regions, Huawei OBS `obs.cn-*`, private addresses, or a host
//     on `CN_ALLOWED_STORAGE_HOST_SUFFIXES` — never the international bucket
//     (`S3_ENDPOINT`). Being named in `CN_S3_ENDPOINT` is NOT enough: an AWS
//     or other offshore endpoint there is refused (`isMainlandStorageHost`);
//   - Aliyun SMS / DirectMail / Content Security (mainland regions), Tencent
//     SMS, WeChat;
//   - the CN LiveKit host (`CN_LIVEKIT_URL`);
//   - private / loopback addresses (in-cluster services);
//   - and, only offshore (CN-0, consent `pipl_cross_border` covers it): the
//     offshore infrastructure the beta runs on — Neon, Vercel, LiveKit Cloud
//     and Resend.
//
// RoboApply — a DENYLIST on top of today's vendors. PI never goes to:
//   - a mainland model endpoint (same host list);
//   - the GoHire parse API, unless `GOHIRE_PARSE_BRANDS` includes roboapply
//     (owner opt-in after the privacy notice discloses it; R-16);
//   - mainland-only service hosts (Aliyun, Tencent Cloud, WeChat).
//
// Both brands: Tavily, Firecrawl and RapidAPI receive NO PI — only company or
// job queries. On the mainland stack GoApply does not call them at all: the
// job-search API that fans out to RapidAPI is closed for the cn market
// (job-search/routes.ts `roboApplyOnly`).
// `assertNoPiInPayload` is the runtime check callers of those vendors run on
// the outgoing query.

import { getBrand, parseBrandId, type BrandId, type ProductBrand } from '../brand/registry.js';
import type { EnvSource } from '../brand/brandEnv.js';
import { hostOf, isMainlandLlmHost } from '../llm/brandPolicy.js';
import { detectPii, knownValuePattern, type PiiKind } from '../pii/redact.js';
import { isCnMainland } from './deployRegion.js';

/** Vendors that may receive company/job queries only, never PI (both brands). */
export const NO_PI_HOST_SUFFIXES = ['tavily.com', 'firecrawl.dev', 'rapidapi.com'] as const;

/** The GoHire parse API and its sibling hosts (a mainland server; CN plan L-10). */
export const GOHIRE_HOST_SUFFIXES = ['gohire.top'] as const;

/** Mainland-only service hosts GoApply may use and RoboApply never sends PI to. */
const CN_SERVICE_HOST_PATTERNS: readonly RegExp[] = [
  /^dysmsapi\.aliyuncs\.com$/, // Aliyun SMS
  /^dm\.aliyuncs\.com$/, // Aliyun DirectMail (Hangzhou)
  /^dm\.cn-[a-z0-9-]+\.aliyuncs\.com$/,
  /^green(?:-cip)?\.cn-[a-z0-9-]+\.aliyuncs\.com$/, // Aliyun Content Security
  /^sms\.tencentcloudapi\.com$/, // Tencent SMS
  /(?:^|\.)weixin\.qq\.com$/, // WeChat open platform, MP, pay
];

/**
 * Mainland object-storage endpoints. Only hosts whose name carries a mainland
 * region qualify (Aliyun OSS `oss-cn-*`, Tencent COS `ap-<mainland city>`,
 * Huawei OBS `obs.cn-*`); `oss-ap-southeast-1` or `s3.us-east-1.amazonaws.com`
 * never do, and neither does a Hong Kong region whatever its prefix
 * (`oss-cn-hongkong`, `cos.ap-hongkong`).
 */
export const MAINLAND_STORAGE_HOST_PATTERNS: readonly RegExp[] = [
  // `oss-cn-hongkong` carries the `cn-` prefix but is the Hong Kong region: outside the mainland.
  /(?:^|\.)oss-cn-(?!hongkong(?:-internal)?\.)[a-z0-9-]+?(?:-internal)?\.aliyuncs\.com$/,
  /(?:^|\.)cos\.ap-(?:beijing|shanghai|guangzhou|chengdu|chongqing|nanjing|shenzhen)(?:-[a-z0-9]+)*\.myqcloud\.com$/,
  /(?:^|\.)obs\.cn-[a-z0-9-]+\.myhuaweicloud\.com$/,
];

/** Extra mainland storage hosts (`CN_ALLOWED_STORAGE_HOST_SUFFIXES`, comma list), e.g. a self-hosted MinIO domain. */
export function allowedCnStorageHostSuffixes(env: EnvSource = process.env): string[] {
  return (env.CN_ALLOWED_STORAGE_HOST_SUFFIXES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
}

/**
 * Whether GoApply may keep files at this host: a mainland object-storage
 * region, a private/loopback address (in-cluster MinIO), or an operator
 * suffix. Never the international bucket host.
 */
export function isMainlandStorageHost(hostOrUrl: string | null | undefined, env: EnvSource = process.env): boolean {
  const host = hostOf(hostOrUrl ?? null);
  if (!host) return false;
  const intl = configuredHost(env, 'S3_ENDPOINT');
  if (intl && host === intl) return false;
  if (isPrivateHost(host)) return true;
  if (MAINLAND_STORAGE_HOST_PATTERNS.some((re) => re.test(host))) return true;
  return anySuffix(host, allowedCnStorageHostSuffixes(env));
}

/** Hosts RoboApply never sends PI to (mainland-only vendors). */
const CN_ONLY_VENDOR_SUFFIXES = ['aliyuncs.com', 'tencentcloudapi.com', 'myqcloud.com', 'weixin.qq.com', 'qq.com'] as const;

/** Offshore infrastructure GoApply's CN-0 beta runs on (allowed offshore only). */
const CN0_OFFSHORE_INFRA_SUFFIXES = ['neon.tech', 'vercel.app', 'vercel.com', 'livekit.cloud', 'resend.com'] as const;

export type EgressPolicyCode =
  | 'invalid_target'
  | 'no_pi_vendor'
  | 'vendor_disabled_in_region'
  | 'host_not_allowlisted_for_cn'
  | 'intl_storage_for_cn'
  | 'mainland_endpoint_for_intl'
  | 'gohire_parse_not_opted_in'
  | 'cn_service_for_intl'
  | 'pi_in_payload';

export type EgressDecision =
  | { allowed: true; host: string }
  | { allowed: false; code: EgressPolicyCode; reason: string; host: string | null };

export interface EgressCheckInput {
  brand: BrandId | ProductBrand;
  /** URL or bare host the request goes to. */
  target: string;
  /** Whether the request carries personal information (default true: assume it does). */
  carriesPi?: boolean;
  env?: EnvSource;
}

export class EgressPolicyError extends Error {
  readonly code = 'egress_blocked' as const;
  readonly policyCode: EgressPolicyCode;
  readonly host: string | null;
  constructor(policyCode: EgressPolicyCode, reason: string, host: string | null) {
    super(reason);
    this.name = 'EgressPolicyError';
    this.policyCode = policyCode;
    this.host = host;
  }
}

function toBrand(brand: BrandId | ProductBrand): ProductBrand {
  return typeof brand === 'string' ? getBrand(brand) : brand;
}

function matchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase().replace(/^\./, '');
  return host === s || host.endsWith(`.${s}`);
}

function anySuffix(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => matchesSuffix(host, s));
}

/** Loopback or RFC 1918 private address (in-cluster services, sidecars). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Brands whose resume uploads go to the GoHire parse API
 * (`GOHIRE_PARSE_BRANDS`, comma list; `intl`/`cn` accepted). Unset or blank →
 * GoApply only (R-16). `none` / `off` → no brand.
 */
export function goHireParseBrands(env: EnvSource = process.env): BrandId[] {
  const rawValue = (env.GOHIRE_PARSE_BRANDS ?? '').trim();
  if (!rawValue) return ['goapply'];
  if (['none', 'off', 'false'].includes(rawValue.toLowerCase())) return [];
  const ids = rawValue
    .split(',')
    .map((s) => parseBrandId(s))
    .filter((id): id is BrandId => id !== null);
  return [...new Set(ids)];
}

export function goHireParseAllowedFor(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  return goHireParseBrands(env).includes(toBrand(brand).id);
}

/** Default GoHire parse API base (`GOHIRE_API_BASE` overrides it). */
export const DEFAULT_GOHIRE_API_BASE = 'https://api.gohire.top';

/**
 * Whether uploads for the brand actually go to the GoHire parse API on this
 * deployment: not switched off (`GOHIRE_PARSE_ENABLED=false`), keyed
 * (`GOHIRE_API_KEY`), the brand is in `GOHIRE_PARSE_BRANDS`, and the API host
 * passes the brand's egress policy. `GoHireResumeParseService.isConfigured`
 * and the privacy summary both use it, so the notice never describes a
 * transfer the deployment does not make.
 */
export function goHireParseActive(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  if ((env.GOHIRE_PARSE_ENABLED ?? '').trim().toLowerCase() === 'false') return false;
  if (!(env.GOHIRE_API_KEY ?? '').trim()) return false;
  if (!goHireParseAllowedFor(brand, env)) return false;
  const base = (env.GOHIRE_API_BASE ?? '').trim() || DEFAULT_GOHIRE_API_BASE;
  return checkEgress({ brand, target: base, carriesPi: true, env }).allowed;
}

export function isNoPiVendorHost(host: string): boolean {
  return anySuffix(host.toLowerCase(), NO_PI_HOST_SUFFIXES);
}

function isCnServiceHost(host: string): boolean {
  return CN_SERVICE_HOST_PATTERNS.some((re) => re.test(host));
}

function configuredHost(env: EnvSource, name: string): string | null {
  const v = env[name];
  return v && v.trim() ? hostOf(v.trim()) : null;
}

function deny(code: EgressPolicyCode, reason: string, host: string | null): EgressDecision {
  return { allowed: false, code, reason, host };
}

/** Decide whether a request to `target` is allowed for the brand. Pure (reads only `env`). */
export function checkEgress(input: EgressCheckInput): EgressDecision {
  const env = input.env ?? process.env;
  const brand = toBrand(input.brand);
  const carriesPi = input.carriesPi !== false;
  const host = hostOf(input.target);
  if (!host) return deny('invalid_target', `Cannot read a host from "${input.target}".`, null);

  const noPiVendor = isNoPiVendorHost(host);
  if (brand.market === 'cn' && noPiVendor && isCnMainland(env)) {
    return deny('vendor_disabled_in_region', `${host} is not used on the mainland stack.`, host);
  }
  if (noPiVendor) {
    return carriesPi
      ? deny('no_pi_vendor', `${host} may receive company or job queries only, never personal information.`, host)
      : { allowed: true, host };
  }
  if (!carriesPi) return { allowed: true, host };

  if (brand.market === 'cn') {
    const intlStorage = configuredHost(env, 'S3_ENDPOINT');
    if (intlStorage && host === intlStorage) {
      // Even when CN_S3_ENDPOINT was (mis)set to the same host.
      return deny('intl_storage_for_cn', `${host} is the international bucket; GoApply data never goes there.`, host);
    }
    if (isPrivateHost(host)) return { allowed: true, host };
    if (isMainlandLlmHost(host, env)) return { allowed: true, host };
    if (anySuffix(host, GOHIRE_HOST_SUFFIXES)) return { allowed: true, host };
    // Storage: only a mainland region (or operator-listed) host — being named
    // in CN_S3_ENDPOINT is not enough.
    if (isMainlandStorageHost(host, env)) return { allowed: true, host };
    const cnLivekit = configuredHost(env, 'CN_LIVEKIT_URL');
    if (cnLivekit && host === cnLivekit) return { allowed: true, host };
    if (isCnServiceHost(host)) return { allowed: true, host };
    if (!isCnMainland(env) && anySuffix(host, CN0_OFFSHORE_INFRA_SUFFIXES)) return { allowed: true, host };
    return deny('host_not_allowlisted_for_cn', `${host} is not on the GoApply list of hosts that may receive personal information.`, host);
  }

  // RoboApply.
  if (isMainlandLlmHost(host, env)) {
    return deny('mainland_endpoint_for_intl', `${host} is in mainland China; user data may not go there.`, host);
  }
  if (anySuffix(host, GOHIRE_HOST_SUFFIXES)) {
    return goHireParseAllowedFor(brand, env)
      ? { allowed: true, host }
      : deny('gohire_parse_not_opted_in', `${host} is a mainland server; this brand has not opted in to GoHire parsing.`, host);
  }
  if (anySuffix(host, CN_ONLY_VENDOR_SUFFIXES)) {
    return deny('cn_service_for_intl', `${host} is a mainland-only service; this brand does not send personal information there.`, host);
  }
  return { allowed: true, host };
}

/** Throws `EgressPolicyError` when the request is not allowed; returns the host otherwise. */
export function assertEgress(input: EgressCheckInput): string {
  const d = checkEgress(input);
  if (!d.allowed) throw new EgressPolicyError(d.code, d.reason, d.host);
  return d.host;
}

/** Kinds that must never appear in a query sent to a no-PI vendor. */
const PAYLOAD_PI_KINDS: readonly PiiKind[] = ['email', 'phone', 'prc_id', 'tw_id', 'us_ssn', 'gov_id'];

function flatten(payload: unknown, out: string[] = []): string[] {
  if (typeof payload === 'string') out.push(payload);
  else if (Array.isArray(payload)) payload.forEach((p) => flatten(p, out));
  else if (payload && typeof payload === 'object') Object.values(payload as Record<string, unknown>).forEach((p) => flatten(p, out));
  return out;
}

export interface NoPiPayloadInput extends Omit<EgressCheckInput, 'carriesPi'> {
  /** The outgoing query: a string, or a JSON-like body. */
  payload: unknown;
  /** Strings that identify the user (name, email) and must not be sent. */
  knownValues?: ReadonlyArray<string | null | undefined>;
}

/**
 * For calls to Tavily / Firecrawl / RapidAPI (and any other no-PI vendor):
 * refuses the call when the host is not allowed for the brand at all, and
 * when the outgoing payload contains detectable PI (an email, a phone number,
 * a government ID, or one of `knownValues`). Returns the host.
 */
export function assertNoPiInPayload(input: NoPiPayloadInput): string {
  const host = assertEgress({ brand: input.brand, target: input.target, carriesPi: false, env: input.env });
  const text = flatten(input.payload).join('\n');
  const kinds: string[] = text ? detectPii(text, PAYLOAD_PI_KINDS) : [];
  // Latin-script values match as whole words ("Li" matches "Li Wei", never
  // "Linux"); CJK values match as substrings (no word spaces in CJK text).
  if (input.knownValues?.some((v) => {
    const re = typeof v === 'string' ? knownValuePattern(v) : null;
    return re ? re.test(text) : false;
  })) {
    kinds.push('known_value');
  }
  if (kinds.length) {
    throw new EgressPolicyError('pi_in_payload', `The query to ${host} contains personal information (${kinds.join(', ')}).`, host);
  }
  return host;
}
