// server/src/features/compliance/consents.ts
//
// The consent catalog and the consent ledger writer (TASK_PLAN.md WP-13;
// PRODUCT_PLAN.md §4.5 G1; CN_TW_LAUNCH_PLAN.md WP-COMPLY).
//
// Rules this module encodes:
//   - Separate, unbundled consents. No optional consent is pre-checked:
//     `defaultGranted` is the literal `false` for every entry, and
//     `personalized_recommendation` starts unanswered (null) — the user must
//     choose 开启 or 关闭 (PIPL Art. 24).
//   - The prose is the exact text shown. It lives here, versioned, so the
//     server can hash what the user saw: every SeekerConsentRecord stores
//     `proseVersion` + `proseHash` (sha256 over brand, type, version, locale
//     and text). A client that sends an older version gets 409 and reloads.
//   - Prose exists in English for both brands and in Simplified Chinese for
//     GoApply (its primary language). Other locales are served the English
//     text and say so (`proseLocale`), so the hash always matches what was
//     shown. Counsel-approved translations are added here as new versions.
//   - Withdrawing `pipl_cross_border` on GoApply while data is processed
//     offshore (CN-0) closes and purges the account: a personal-information
//     request is opened and a `compliance.purge` work item is enqueued.
//   - The agreement and the age confirmation cannot be withdrawn one by one;
//     they end with the account (delete account in #danger).

import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { HttpError } from '../../platform/http.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { enqueue, kickDrain } from '../../platform/queue/index.js';
import { isSeekerConsentType, type SeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import {
  COMPLIANCE_ERROR_CODES,
  type ConsentCatalogItem,
  type RecordConsentResponse,
} from './contract.js';
import { piRequestDueAt } from './piRequests.js';
import { COMPLIANCE_WORK_KINDS } from './kinds.js';

/** Bump when any prose below changes (≤ 40 chars; stored on every record). */
export const CONSENT_PROSE_VERSION = '2026-10-10.wp13.v1';

export type ConsentRequirement = 'always' | 'offshore' | 'tw' | 'never';
export type ConsentApplicability = 'always' | 'offshore' | 'tw' | 'gohire_parse_intl';

export interface ConsentDefinition {
  type: SeekerConsentType;
  brand: BrandId;
  requiredWhen: ConsentRequirement;
  /** When the consent is offered at all (e.g. the cross-border consent only while offshore). */
  appliesWhen: ConsentApplicability;
  stage: 'signup' | 'in_context';
  control: 'checkbox' | 'toggle' | 'two_option';
  withdrawable: boolean;
  onWithdraw: 'none' | 'close_and_purge_account';
  defaultGranted: false;
  /** Prose per locale; `en` is required. `%BRAND%` is substituted per brand. */
  prose: { en: string; zh?: string };
}

const OFFSHORE_PROCESSORS_ZH =
  '数据库 Neon（美国东部）、网站托管 Vercel（美国）、语音练习 LiveKit Cloud、语音识别与合成 Deepgram / Cartesia、邮件发送 Resend';
const OFFSHORE_PROCESSORS_EN =
  'the database at Neon (US East), hosting at Vercel (United States), voice practice at LiveKit Cloud, speech recognition and synthesis at Deepgram / Cartesia, and email delivery at Resend';

/** The catalog, in display order per brand. */
export const CONSENT_CATALOG: readonly ConsentDefinition[] = [
  // ── GoApply (PRODUCT §4.5 G1; CN plan WP-COMPLY) ─────────────────────────
  {
    type: 'pipl_basic_processing',
    brand: 'goapply',
    requiredWhen: 'always',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'checkbox',
    withdrawable: false,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '我已阅读并同意《用户协议》和《隐私政策》。',
      en: 'I have read and agree to the User Agreement and the Privacy Policy.',
    },
  },
  {
    type: 'age_16_plus',
    brand: 'goapply',
    requiredWhen: 'always',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'checkbox',
    withdrawable: false,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { zh: '我已年满16周岁。', en: 'I am 16 or older.' },
  },
  {
    type: 'pipl_cross_border',
    brand: 'goapply',
    requiredWhen: 'offshore',
    appliesWhen: 'offshore',
    stage: 'signup',
    control: 'checkbox',
    withdrawable: true,
    onWithdraw: 'close_and_purge_account',
    defaultGranted: false,
    prose: {
      zh:
        `在当前内测阶段，你的个人信息在中国大陆境外处理和存储，处理地区为美国。境外处理方：${OFFSHORE_PROCESSORS_ZH}。` +
        '我同意上述境外处理。我知道撤回此同意会关闭我的账户并删除我的数据。',
      en:
        `During this closed beta your personal information is processed and stored outside mainland China, in the United States. Processors outside mainland China: ${OFFSHORE_PROCESSORS_EN}. ` +
        'I agree to this processing. I understand that withdrawing this consent closes my account and deletes my data.',
    },
  },
  {
    type: 'ai_resume_parsing',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh:
        '使用 AI 读取我的简历并准备求职材料。处理的内容：你的简历、个人资料和你选择的职位信息；处理方：“AI 模型说明”中列出的模型。' +
        '关闭时，你可以手动填写资料；简历解析、简历改写、求职信和求职助手将不可用，匹配度改为不使用 AI 的快速估算。',
      en:
        'Use AI to read my resume and prepare application materials. What is processed: your resume, your profile and the jobs you choose; by: the models listed in the AI disclosure. ' +
        'When this is off you can fill in your profile by hand; resume reading, rewriting, cover letters and the Assistant are unavailable, and fit uses a quick estimate without AI.',
    },
  },
  {
    type: 'personalized_recommendation',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'two_option',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '根据我的资料为职位排序。关闭或未选择时，职位只按发布时间和筛选条件排序，不显示匹配度。你可以随时在设置中更改。',
      en: 'Rank jobs using my profile. When this is off or not chosen, jobs are sorted only by date posted and your filters, with no fit scores. You can change this anytime in Settings.',
    },
  },
  {
    type: 'marketing_email',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { zh: '接收 %BRAND% 的产品动态（短信或邮件）。', en: 'Send me %BRAND% product news by message or email.' },
  },
  {
    type: 'pipl_sensitive_pi',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'checkbox',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '我同意 %BRAND% 处理我主动填写的敏感个人信息（例如照片、健康信息、证件信息），仅用于填写我选择的申请表，不用于匹配或 AI 处理。',
      en: 'I agree that %BRAND% may process sensitive information I enter myself (for example a photo, health or ID details), only to fill in application forms I choose — never for matching or AI processing.',
    },
  },
  {
    type: 'share_with_gohire',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '允许把我的简历和求职意向分享给 GoHire 上的招聘方。关闭后不再分享，已分享的内容由招聘方按其政策处理。',
      en: 'Share my resume and job preferences with employers on GoHire. Turning this off stops new sharing; anything already shared is handled under the employer’s own policy.',
    },
  },
  {
    type: 'interview_recording',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '保存我的面试练习录音和文字记录，供我回看。保存 90 天后自动删除。',
      en: 'Keep the audio and transcript of my practice interviews so I can review them. They are deleted automatically after 90 days.',
    },
  },
  {
    type: 'copilot_memory',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '允许求职助手记住我说过的偏好，用于以后的对话。你可以随时查看和删除。',
      en: 'Let the Assistant remember preferences I tell it, for later conversations. You can review and delete them anytime.',
    },
  },
  // ── RoboApply (PRODUCT §4.1; CN plan "intl signup") ──────────────────────
  {
    type: 'age_16_plus',
    brand: 'roboapply',
    requiredWhen: 'always',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'checkbox',
    withdrawable: false,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: 'I am 16 or older (or the age of digital consent where I live, if higher).' },
  },
  {
    type: 'tw_pdpa_notice',
    brand: 'roboapply',
    requiredWhen: 'tw',
    appliesWhen: 'tw',
    stage: 'signup',
    control: 'checkbox',
    withdrawable: false,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      en: 'I have read the Taiwan Personal Data Protection Act notice: who collects my data, why, what is collected, how long it is kept, where it is processed, and my rights to access, correct, stop and delete it.',
    },
  },
  {
    type: 'marketing_email',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'signup',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: 'Send me %BRAND% product news by email.' },
  },
  {
    type: 'intl_cross_border_cn_parse',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'gohire_parse_intl',
    stage: 'in_context',
    control: 'checkbox',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      en: 'Read my uploaded resume with the GoHire parsing service, which runs on servers in mainland China. If you decline, your resume is read without it, or you can enter your details by hand.',
    },
  },
  {
    type: 'interview_recording',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: 'Keep the audio and transcript of my practice interviews so I can review them. They are deleted automatically after 90 days.' },
  },
  {
    type: 'copilot_memory',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: 'Let the Assistant remember preferences I tell it, for later conversations. You can review and delete them anytime.' },
  },
  {
    type: 'tips_reminders',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: 'Send me tips and reminders about jobs I saved and practice I started.' },
  },
];

// ── Context ────────────────────────────────────────────────────────────────

export interface ConsentContext {
  env?: EnvSource;
  /** Visitor/user country (ISO alpha-2), for the Taiwan notice. */
  country?: string | null;
  locale?: string | null;
}

/** GoApply data is processed outside the mainland unless the deployment says otherwise (CN-0). */
export function isOffshore(env: EnvSource = process.env): boolean {
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase() !== 'cn-mainland';
}

/** RoboApply resumes go to the mainland GoHire parser only when the owner opted in (R-16, OD-3). */
export function gohireParseForIntl(env: EnvSource = process.env): boolean {
  return (env.GOHIRE_PARSE_BRANDS ?? 'goapply')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('roboapply');
}

function isTaiwan(ctx: ConsentContext): boolean {
  return (ctx.country ?? '').toUpperCase() === 'TW' || ctx.locale === 'zh-TW';
}

function holds(cond: ConsentRequirement | ConsentApplicability, ctx: ConsentContext): boolean {
  const env = ctx.env ?? process.env;
  switch (cond) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'offshore':
      return isOffshore(env);
    case 'tw':
      return isTaiwan(ctx);
    case 'gohire_parse_intl':
      return gohireParseForIntl(env);
  }
}

export function consentDefinitionsFor(brand: BrandId): ConsentDefinition[] {
  return CONSENT_CATALOG.filter((d) => d.brand === brand);
}

export function findConsentDefinition(brand: BrandId, type: string): ConsentDefinition | null {
  return CONSENT_CATALOG.find((d) => d.brand === brand && d.type === type) ?? null;
}

export function isConsentApplicable(def: ConsentDefinition, ctx: ConsentContext): boolean {
  return holds(def.appliesWhen, ctx);
}

export function isConsentRequired(def: ConsentDefinition, ctx: ConsentContext): boolean {
  return holds(def.appliesWhen, ctx) && holds(def.requiredWhen, ctx);
}

// ── Prose, version and hash ─────────────────────────────────────────────────

export interface ResolvedProse {
  text: string;
  locale: 'en' | 'zh';
  version: string;
  hash: string;
}

/** The locale whose prose is served: zh (GoApply only, when asked for zh) or English. */
export function proseLocaleFor(def: ConsentDefinition, locale: string | null | undefined): 'en' | 'zh' {
  return locale === 'zh' && def.prose.zh ? 'zh' : 'en';
}

export function consentProseHash(input: { brand: BrandId; type: string; version: string; locale: string; text: string }): string {
  return crypto
    .createHash('sha256')
    .update([input.brand, input.type, input.version, input.locale, input.text].join('\n'))
    .digest('hex');
}

export function resolveConsentProse(def: ConsentDefinition, brand: ProductBrand, locale: string | null | undefined): ResolvedProse {
  const lang = proseLocaleFor(def, locale);
  const raw = (lang === 'zh' ? def.prose.zh : def.prose.en) ?? def.prose.en;
  const text = raw.split('%BRAND%').join(brand.name);
  return {
    text,
    locale: lang,
    version: CONSENT_PROSE_VERSION,
    hash: consentProseHash({ brand: brand.id, type: def.type, version: CONSENT_PROSE_VERSION, locale: lang, text }),
  };
}

// ── Signup validation (WP-10 / WP-11 / WP-31 call this) ─────────────────────

export interface SubmittedConsent {
  type: string;
  granted: boolean;
  proseVersion: string;
}

export interface SignupConsentCheck {
  ok: boolean;
  /** Required consents not granted. */
  missing: SeekerConsentType[];
  /** Types the brand does not offer here, or with an outdated prose version. */
  invalid: string[];
}

/** Every required consent granted with the current prose; nothing unknown. */
export function validateSignupConsents(brand: BrandId, submitted: SubmittedConsent[], ctx: ConsentContext = {}): SignupConsentCheck {
  const invalid: string[] = [];
  for (const c of submitted) {
    const def = findConsentDefinition(brand, c.type);
    if (!def || !isConsentApplicable(def, ctx) || c.proseVersion !== CONSENT_PROSE_VERSION) invalid.push(c.type);
  }
  const missing = consentDefinitionsFor(brand)
    .filter((d) => d.stage === 'signup' && isConsentRequired(d, ctx))
    .filter((d) => !submitted.some((c) => c.type === d.type && c.granted === true))
    .map((d) => d.type);
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/**
 * The signup form's initial state: every consent unchecked, the
 * personalisation choice unset. Pure; tests assert nothing starts as true.
 */
export function initialConsentFormState(brand: BrandId, ctx: ConsentContext = {}): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const d of consentDefinitionsFor(brand)) {
    if (d.stage !== 'signup' || !isConsentApplicable(d, ctx)) continue;
    out[d.type] = d.control === 'two_option' ? null : d.defaultGranted;
  }
  return out;
}

// ── Ledger ─────────────────────────────────────────────────────────────────

export type ConsentDb = Pick<typeof prisma, 'seekerProfile' | 'seekerConsentRecord' | 'rAPersonalInfoRequest' | '$transaction'>;

export interface ConsentServiceDeps {
  db?: ConsentDb;
  env?: EnvSource;
  now?: () => Date;
  enqueue?: typeof enqueue;
  kick?: (kinds: string[]) => unknown;
}

async function profileIdFor(db: ConsentDb, userId: string): Promise<string> {
  const profile = await db.seekerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (!profile) throw new HttpError('not_found', 'No seeker profile for this account.');
  return profile.id;
}

/** Catalog + the user's current answers, for #consents and in-context prompts. */
export async function listConsents(
  userId: string,
  brand: ProductBrand,
  ctx: ConsentContext & { locale?: string | null },
  deps: ConsentServiceDeps = {},
): Promise<ConsentCatalogItem[]> {
  const db = deps.db ?? prisma;
  const profileId = await profileIdFor(db, userId);
  const defs = consentDefinitionsFor(brand.id);
  const records = await db.seekerConsentRecord.findMany({
    where: { seekerProfileId: profileId, consentType: { in: defs.map((d) => d.type) } },
    orderBy: { createdAt: 'desc' },
    select: { consentType: true, granted: true, createdAt: true },
  });
  const latest = new Map<string, { granted: boolean; createdAt: Date }>();
  for (const r of records) if (!latest.has(r.consentType)) latest.set(r.consentType, r);

  const fullCtx = { ...ctx, env: ctx.env ?? deps.env };
  return defs
    .filter((d) => isConsentApplicable(d, fullCtx) || latest.has(d.type))
    .map((d) => {
      const prose = resolveConsentProse(d, brand, ctx.locale);
      const rec = latest.get(d.type);
      return {
        type: d.type,
        required: isConsentRequired(d, fullCtx),
        stage: d.stage,
        control: d.control,
        withdrawable: d.withdrawable,
        onWithdraw: d.onWithdraw === 'close_and_purge_account' && isOffshore(fullCtx.env ?? process.env) ? d.onWithdraw : 'none',
        defaultGranted: false as const,
        prose: prose.text,
        proseVersion: prose.version,
        proseHash: prose.hash,
        proseLocale: prose.locale,
        granted: rec ? rec.granted : null,
        answeredAt: rec ? rec.createdAt.toISOString() : null,
      };
    });
}

export interface RecordConsentInput {
  userId: string;
  brand: ProductBrand;
  type: string;
  granted: boolean;
  proseVersion: string;
  locale?: string | null;
  country?: string | null;
}

/**
 * Write one consent record with the prose hash. Withdrawing the CN-0
 * cross-border consent opens a personal-information request and enqueues the
 * account purge (`compliance.purge`).
 */
export async function recordConsent(input: RecordConsentInput, deps: ConsentServiceDeps = {}): Promise<RecordConsentResponse> {
  const db = deps.db ?? prisma;
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const def = isSeekerConsentType(input.type) ? findConsentDefinition(input.brand.id, input.type) : null;
  if (!def) {
    throw new HttpError('invalid_request', 'This consent is not offered here.', { reason: COMPLIANCE_ERROR_CODES.consentUnknown });
  }
  if (input.proseVersion !== CONSENT_PROSE_VERSION) {
    throw new HttpError('version_conflict', 'The consent text changed. Reload to see the current text.', {
      reason: COMPLIANCE_ERROR_CODES.proseOutdated,
      currentVersion: CONSENT_PROSE_VERSION,
    });
  }
  if (!input.granted && !def.withdrawable) {
    throw new HttpError('invalid_request', 'This consent ends only by deleting the account.', {
      reason: COMPLIANCE_ERROR_CODES.consentNotWithdrawable,
    });
  }

  const prose = resolveConsentProse(def, input.brand, input.locale);
  const profileId = await profileIdFor(db, input.userId);
  const closing = !input.granted && def.onWithdraw === 'close_and_purge_account' && isOffshore(env);

  // The consent record and (for a closing withdrawal) its request commit
  // together. A retry reuses the open withdrawal request instead of opening a
  // second one; the purge is enqueued after commit with a per-user dedupe key,
  // so a retry after a failed enqueue queues it against the same request.
  const { row, requestId } = await db.$transaction(async (tx) => {
    const created = await tx.seekerConsentRecord.create({
      data: {
        seekerProfileId: profileId,
        consentType: def.type,
        granted: input.granted,
        proseVersion: prose.version,
        proseHash: prose.hash,
      },
      select: { createdAt: true },
    });
    if (!closing) return { row: created, requestId: null as string | null };
    const open = await tx.rAPersonalInfoRequest.findFirst({
      where: { userId: input.userId, kind: 'withdraw_consent', status: { in: ['open', 'in_progress'] } },
      select: { id: true },
    });
    const request =
      open ??
      (await tx.rAPersonalInfoRequest.create({
        data: {
          brand: input.brand.id,
          userId: input.userId,
          kind: 'withdraw_consent',
          status: 'in_progress',
          dueAt: piRequestDueAt(input.brand.id, now),
          detail: { reason: 'pipl_cross_border_withdrawn' },
        },
        select: { id: true },
      }));
    return { row: created, requestId: request.id };
  });

  if (closing && requestId) {
    await (deps.enqueue ?? enqueue)(
      COMPLIANCE_WORK_KINDS.retentionPurge,
      { userId: input.userId, piRequestId: requestId, reason: 'pipl_cross_border_withdrawn' },
      { brand: input.brand.id, userId: input.userId, dedupeKey: `compliance.purge:${input.userId}`, priority: 10 },
    );
    (deps.kick ?? kickDrain)([COMPLIANCE_WORK_KINDS.retentionPurge]);
  }

  return {
    type: def.type,
    granted: input.granted,
    proseVersion: prose.version,
    proseHash: prose.hash,
    at: (row.createdAt ?? now).toISOString(),
    accountClosing: closing,
  };
}
