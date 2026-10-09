// server/src/features/compliance/disclosures.ts
//
// What we disclose about AI models, processors and filings, and the legal
// footer — every value read from configuration (D3). Nothing is shown that
// ops has not set: an unset filing number is absent (never "pending"), a model
// is named as soon as it is configured (CN plan §5.3), and "备案中" appears only
// as the verbatim CN_GENAI_STATUS_NOTE when ops sets it.

import type { ProductBrand } from '../../platform/brand/registry.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import {
  ICP_LOOKUP_URL,
  LEGAL_FOOTER_DOCS,
  PSB_LOOKUP_URL_PREFIX,
  type AiModelDisclosure,
  type DisclosuresResponse,
  type LegalFooterModel,
  type ProcessorPurpose,
} from './contract.js';
import { isOffshore } from './consents.js';

function val(env: EnvSource, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.trim();
  return t ? t : null;
}

/** LLM task env names (unprefixed; GoApply reads `CN_` + name, R-03). */
export const LLM_TASK_ENV: ReadonlyArray<[task: string, name: string]> = [
  ['default', 'LLM_MODEL'],
  ['matching', 'LLM_MATCHING_MODEL'],
  ['extract', 'LLM_EXTRACT_MODEL'],
  ['onboarding', 'LLM_ONBOARDING_MODEL'],
  ['rewrite', 'LLM_REWRITE_MODEL'],
  ['writing', 'LLM_WRITING_MODEL'],
  ['assistant', 'LLM_COPILOT_MODEL'],
  ['enrich', 'LLM_ENRICH_MODEL'],
  ['practice', 'LLM_INTERVIEW_MODEL'],
  ['fallback', 'LLM_FALLBACK_MODEL'],
  ['vision', 'LLM_VISION_MODEL'],
];

/**
 * Country of each vendor's processing endpoint as we contract it. Only
 * vendors we know are listed; anything else renders "Not listed".
 */
export const VENDOR_COUNTRY: Readonly<Record<string, string>> = {
  openrouter: 'US',
  openai: 'US',
  anthropic: 'US',
  google: 'US',
  'x-ai': 'US',
  deepseek: 'CN',
  qwen: 'CN',
  dashscope: 'CN',
  kimi: 'CN',
  moonshot: 'CN',
  moonshotai: 'CN',
  glm: 'CN',
  zhipu: 'CN',
  doubao: 'CN',
  ark: 'CN',
  minimax: 'CN',
};

/**
 * Split a configured model id into vendor + model. `openrouter/google/x` is
 * served by OpenRouter (the processor we send data to), model `google/x`.
 * A bare id takes the brand's provider env (LLM_PROVIDER / CN_LLM_PROVIDER).
 */
export function parseModelId(id: string, provider: string | null): { vendor: string; model: string } {
  const parts = id.split('/');
  if (parts.length > 1) {
    const [first, ...rest] = parts;
    return { vendor: first!.toLowerCase(), model: rest.join('/') };
  }
  return { vendor: (provider ?? 'unknown').toLowerCase(), model: id };
}

interface GenaiFiling {
  model: string;
  vendor: string;
  filingNo: string | null;
}

/** CN_GENAI_DISCLOSURES: JSON `[{ model, vendor, filingNo }]`; malformed → none. */
export function parseGenaiDisclosures(raw: string | null): GenaiFiling[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .filter((x) => typeof x.model === 'string' && typeof x.vendor === 'string')
      .map((x) => ({
        model: String(x.model),
        vendor: String(x.vendor),
        filingNo: typeof x.filingNo === 'string' && x.filingNo.trim() ? x.filingNo.trim() : null,
      }));
  } catch {
    return [];
  }
}

/** Models configured for the brand, deduplicated, with filing numbers when set. */
export function configuredModels(brand: ProductBrand, env: EnvSource = process.env): AiModelDisclosure[] {
  const provider = brandEnv(brand, 'LLM_PROVIDER', env) ?? null;
  const filings = brand.market === 'cn' ? parseGenaiDisclosures(val(env, 'CN_GENAI_DISCLOSURES')) : [];
  const out: AiModelDisclosure[] = [];
  const seen = new Set<string>();
  for (const [task, name] of LLM_TASK_ENV) {
    const id = brandEnv(brand, name, env);
    if (!id) continue;
    const { vendor, model } = parseModelId(id, provider);
    const key = `${vendor}/${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filing = filings.find((f) => f.model === model || f.model === id);
    out.push({ task, vendor, model, region: VENDOR_COUNTRY[vendor] ?? null, filingNo: filing?.filingNo ?? null });
  }
  // Models ops disclosed with a filing that are not in the task env (e.g. used by the voice worker).
  for (const f of filings) {
    const key = `${f.vendor.toLowerCase()}/${f.model}`;
    if (seen.has(key) || out.some((m) => m.model === f.model)) continue;
    seen.add(key);
    out.push({ task: 'other', vendor: f.vendor.toLowerCase(), model: f.model, region: VENDOR_COUNTRY[f.vendor.toLowerCase()] ?? null, filingNo: f.filingNo });
  }
  return out;
}

export function neonRegion(databaseUrl: string | null): string | null {
  if (!databaseUrl) return null;
  const m = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech/i.exec(databaseUrl);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Country of an AWS region Neon runs in. Only regions we can name with
 * certainty are listed; anything else (or no parsable region) is null and
 * renders "Not listed" — never a guessed country.
 */
const AWS_REGION_COUNTRY: Readonly<Record<string, string>> = {
  'us-east-1': 'US',
  'us-east-2': 'US',
  'us-west-1': 'US',
  'us-west-2': 'US',
  'ca-central-1': 'CA',
  'sa-east-1': 'BR',
  'eu-central-1': 'DE',
  'eu-west-1': 'IE',
  'eu-west-2': 'GB',
  'eu-west-3': 'FR',
  'eu-north-1': 'SE',
  'ap-southeast-1': 'SG',
  'ap-southeast-2': 'AU',
  'ap-northeast-1': 'JP',
  'ap-northeast-2': 'KR',
  'ap-south-1': 'IN',
};

export function awsRegionCountry(region: string | null): string | null {
  return region ? (AWS_REGION_COUNTRY[region] ?? null) : null;
}

/** Processors derived from what this deployment is configured to use. */
export function configuredProcessors(brand: ProductBrand, env: EnvSource = process.env): DisclosuresResponse['processors'] {
  const out: DisclosuresResponse['processors'] = [];
  const add = (name: string, purpose: ProcessorPurpose, country: string | null, region: string | null = null) => {
    if (!out.some((p) => p.name === name && p.purpose === purpose)) out.push({ name, purpose, country, region });
  };
  const db = val(env, 'DATABASE_URL');
  if (db && /neon\.tech/i.test(db)) {
    const region = neonRegion(db);
    add('Neon', 'database', awsRegionCountry(region), region);
  }
  if (val(env, 'VERCEL') || val(env, 'VERCEL_ENV')) add('Vercel', 'hosting', 'US');
  const cn = brand.market === 'cn';
  const transport = cn ? (val(env, 'CN_EMAIL_TRANSPORT') ?? '').toLowerCase() : 'resend';
  if (val(env, 'RESEND_API_KEY') && transport === 'resend') add('Resend', 'email', 'US');
  if (cn && transport === 'aliyun_dm' && val(env, 'ALIYUN_DM_ACCESS_KEY_ID')) add('Aliyun DirectMail', 'email', 'CN');
  if (brandEnv(brand, 'LIVEKIT_URL', env)) add('LiveKit Cloud', 'voice', null);
  if (val(env, 'DEEPGRAM_API_KEY')) add('Deepgram', 'speech', 'US');
  if (val(env, 'CARTESIA_API_KEY')) add('Cartesia', 'speech', 'US');
  if (!cn && val(env, 'STRIPE_SECRET_KEY')) add('Stripe', 'payments', 'US');
  if (brandEnv(brand, 'S3_BUCKET', env)) add(cn ? 'Object storage (CN)' : 'Object storage', 'storage', null);
  for (const m of configuredModels(brand, env)) add(m.vendor, 'ai_models', m.region);
  return out;
}

function filings(brand: ProductBrand, env: EnvSource): DisclosuresResponse['filings'] {
  if (brand.market !== 'cn') return {};
  const out: DisclosuresResponse['filings'] = {};
  const icp = val(env, 'CN_ICP_NUMBER');
  const psb = val(env, 'CN_PSB_NUMBER');
  const edi = val(env, 'CN_EDI_LICENCE_NUMBER');
  const hr = val(env, 'CN_HR_LICENCE_NUMBER');
  const genai = val(env, 'CN_GENAI_APP_REGISTRATION_NO');
  const algo = val(env, 'CN_ALGORITHM_FILING_NO');
  if (icp) out.icp = icp;
  if (psb) out.psb = psb;
  if (edi) out.edi = edi;
  if (hr) out.hrLicence = hr;
  if (genai) out.genaiRegistration = genai;
  if (algo) out.algorithmFiling = algo;
  return out;
}

export function buildDisclosures(brand: ProductBrand, env: EnvSource = process.env): DisclosuresResponse {
  return {
    brand: brand.id,
    models: configuredModels(brand, env),
    filings: filings(brand, env),
    processors: configuredProcessors(brand, env),
    offshore: brand.market === 'cn' && isOffshore(env),
    statusNote: brand.market === 'cn' ? val(env, 'CN_GENAI_STATUS_NOTE') : null,
  };
}

/** The legal footer for a brand; every line only when its value is set. */
export function buildLegalFooter(brand: ProductBrand, env: EnvSource = process.env): LegalFooterModel {
  const cn = brand.market === 'cn';
  const entity = brandEnv(brand, 'LEGAL_ENTITY_NAME', env) ?? (brand.legalEntity || null);
  const icp = cn ? val(env, 'CN_ICP_NUMBER') : null;
  const psb = cn ? val(env, 'CN_PSB_NUMBER') : null;
  const psbCode = cn ? val(env, 'CN_PSB_RECORD_CODE') : null;
  const hr = cn ? val(env, 'CN_HR_LICENCE_NUMBER') : null;
  const hrHolder = cn ? val(env, 'CN_HR_LICENCE_HOLDER') : null;
  const complaintEmail = cn ? val(env, 'CN_COMPLAINT_EMAIL') : null;
  const complaintPhone = cn ? val(env, 'CN_COMPLAINT_PHONE') : null;
  const showModels = Boolean(brand.legal.aiModelDisclosure);
  return {
    brand: brand.id,
    market: brand.market,
    entity,
    links: LEGAL_FOOTER_DOCS[brand.market].map((doc) => ({ doc, href: `/legal/${doc}` })),
    icp: icp ? { number: icp, url: ICP_LOOKUP_URL } : null,
    psb: psb ? { number: psb, url: psbCode ? `${PSB_LOOKUP_URL_PREFIX}${encodeURIComponent(psbCode)}` : null } : null,
    edi: cn ? val(env, 'CN_EDI_LICENCE_NUMBER') : null,
    hrLicence: hr && hrHolder ? { number: hr, holder: hrHolder } : null,
    aiModels: showModels ? configuredModels(brand, env).map(({ vendor, model, filingNo }) => ({ vendor, model, filingNo })) : [],
    genaiRegistration: cn ? val(env, 'CN_GENAI_APP_REGISTRATION_NO') : null,
    algorithmFiling: cn ? val(env, 'CN_ALGORITHM_FILING_NO') : null,
    statusNote: cn ? val(env, 'CN_GENAI_STATUS_NOTE') : null,
    complaints: complaintEmail || complaintPhone ? { email: complaintEmail, phone: complaintPhone } : null,
  };
}
