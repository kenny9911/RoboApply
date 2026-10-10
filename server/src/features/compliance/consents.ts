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
//     GoApply (its primary language). A locale an entry has no text for is
//     served the English text and says so (`proseLocale`), so the hash always
//     matches what was shown. `tips_reminders` (a notification choice, not a
//     legal notice) is translated into every locale; counsel-approved
//     translations of the other entries are added here as new versions.
//   - With no locale given, the prose is served in the brand's default
//     language (GoApply: Chinese), never English by accident.
//   - WHO processes data offshore and WHERE AI requests go are not typed into
//     the prose: `%OFFSHORE_PROCESSORS%` and `%AI_PLACE%` are filled from the
//     configuration the /legal disclosures render (processingStatement.ts),
//     so the consent and the legal page cannot disagree (D3). The hash covers
//     the text as served.
//   - The catalog says which text a stored answer was given to
//     (`answeredProseVersion`, `answeredTextCurrent`): a screen may call the
//     text it shows "what you agreed to" only when the record's hash matches
//     that text. A grant of an earlier text is asked again where it is
//     required (G1) and can be renewed in Settings. A record with no hash
//     cannot be compared: the answer is null (unknown), and no screen says
//     the text changed.
//   - Withdrawing `pipl_cross_border` on GoApply while data is processed
//     offshore (CN-0) closes and purges the account: a personal-information
//     request is opened and a `compliance.purge` work item is enqueued.
//   - The agreement and the age confirmation cannot be withdrawn one by one;
//     they end with the account (delete account in #danger).
//   - Adding an entry never changes another entry's hash: the hash covers the
//     entry's own brand, type, locale and text plus CONSENT_PROSE_VERSION, so
//     new entries are added under the current version (consents.test.ts pins
//     every earlier hash). Bump the version only when existing text changes.
//   - `proseStatus: 'draft'` marks wording counsel has not approved yet. It is
//     metadata for reviewers; the text shown and hashed is the `prose` itself.

import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { HttpError } from '../../platform/http.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { enqueue, kickDrain } from '../../platform/queue/index.js';
import { isSeekerConsentType, type SeekerConsentType } from '../../roboapply/engine/lib/seekerConsentTypes.js';
import {
  COMPLIANCE_ERROR_CODES,
  CONSENT_PROSE_LOCALES,
  type ConsentCatalogItem,
  type ConsentProseLocale,
  type RecordConsentResponse,
} from './contract.js';
import { piRequestDueAt } from './piRequests.js';
import { COMPLIANCE_WORK_KINDS } from './kinds.js';
import { isOffshore } from './deployment.js';
import { aiPlaceSentence, offshoreProcessorsSentence } from './processingStatement.js';

export { isOffshore } from './deployment.js';

/**
 * Bump when any prose below changes (≤ 40 chars; stored on every record).
 * v2 (2026-10-11): the cross-border and AI-processing texts state processors
 * and AI destinations from configuration; `tips_reminders` is translated.
 */
export const CONSENT_PROSE_VERSION = '2026-10-11.fix8.v2';

// Languages a consent text may be written in: declared in the contract (the language of a served
// prose is on the wire of other areas too), re-exported here for this area's callers.
export { CONSENT_PROSE_LOCALES, type ConsentProseLocale };

/** Filled per request from configuration (processingStatement.ts); never typed into a prose. */
export const OFFSHORE_PROCESSORS_TOKEN = '%OFFSHORE_PROCESSORS%';
export const AI_PLACE_TOKEN = '%AI_PLACE%';

export type ConsentRequirement = 'always' | 'offshore' | 'tw' | 'never';
/**
 * When the catalog offers a consent. `never` = defined so a record can be
 * written and read (`recordConsent` does not look at applicability), but not
 * offered: `listConsents` shows it only once the user has a record of it.
 */
export type ConsentApplicability = 'always' | 'offshore' | 'tw' | 'gohire_parse_intl' | 'never';

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
  /**
   * Prose per locale; `en` is required. `%BRAND%` is substituted per brand,
   * `%OFFSHORE_PROCESSORS%` and `%AI_PLACE%` from the deployment's configuration.
   */
  prose: { en: string } & Partial<Record<Exclude<ConsentProseLocale, 'en'>, string>>;
  /** 'draft' = counsel has not approved this wording yet (the final text becomes a new prose version). */
  proseStatus?: 'draft';
}

/** Every locale's text of the "Tips and reminders" choice (the switch label's own words per locale). */
const TIPS_REMINDERS_PROSE = {
  en: 'Send me tips and reminders about jobs I saved and practice I started.',
  zh: '向我发送与我收藏的职位和已开始的练习有关的小贴士和提醒。',
  'zh-TW': '傳送與我收藏的職缺和已開始的練習有關的小提示與提醒給我。',
  ja: '保存した求人や始めた練習に関するヒントとリマインダーを受け取る。',
  ko: '저장한 채용공고와 시작한 연습에 관한 팁과 리마인더를 받을게요.',
  es: 'Quiero recibir consejos y recordatorios sobre los empleos que guardé y las prácticas que empecé.',
  fr: 'Envoyez-moi des conseils et des rappels sur les offres que j’ai enregistrées et les entraînements que j’ai commencés.',
  pt: 'Quero receber dicas e lembretes sobre as vagas que salvei e os treinos que comecei.',
  de: 'Schickt mir Tipps und Erinnerungen zu Jobs, die ich gespeichert habe, und zu Übungen, die ich begonnen habe.',
} as const satisfies ConsentDefinition['prose'];

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
      // %OFFSHORE_PROCESSORS% = the /legal processor rows outside mainland China, in words
      // (each with its country and region). No processor or region is written here.
      zh:
        '在当前内测阶段，你的个人信息在中国大陆境外处理和存储。%OFFSHORE_PROCESSORS%' +
        '我同意上述境外处理。我知道撤回此同意会关闭我的账户并删除我的数据。',
      en:
        'During this closed beta your personal information is processed and stored outside mainland China. %OFFSHORE_PROCESSORS%' +
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
        '使用 AI 读取我的简历并准备求职材料。处理的内容：你的简历、个人资料和你选择的职位信息；处理方：“AI 模型说明”中列出的模型。%AI_PLACE%' +
        '关闭时，你可以手动填写资料；简历解析、简历改写、求职信和求职助手将不可用，匹配度改为不使用 AI 的快速估算。',
      en:
        'Use AI to read my resume and prepare application materials. What is processed: your resume, your profile and the jobs you choose; by: the models listed in the AI disclosure. %AI_PLACE%' +
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
    // The extension (WP-55a) fills stored sensitive answers only with this
    // live grant (profile service `sensitiveForAutofill`, WP-19). Wave 2 gate.
    type: 'autofill_sensitive',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '允许 %BRAND% 浏览器插件把我填写的敏感信息（例如籍贯、政治面貌、家庭成员）填入我自己打开的申请表，由我检查后自行提交。这些信息不用于匹配或 AI 处理。关闭后插件不再填写这些信息。',
      en: 'Let the %BRAND% browser extension fill sensitive answers I entered (for example native place, political status or family members) into application forms I open myself, for me to check and submit. They are never used for matching or AI processing. Turning this off stops the extension from filling them.',
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
    // Camera video of a practice interview is recorded only with this live
    // grant, on top of `interview_recording` (InterviewSessionService
    // practiceRecordingConsent, WP-43 → WP-93). Until it is granted the engine
    // records audio only. `interview_recording` keeps its audio-and-transcript
    // wording: video is this separate, later choice.
    //
    // NOT OFFERED on GoApply (`appliesWhen: 'never'`): GoApply records audio
    // only, always (CN L-11, getInterviewMediaPolicy: cameraPublish and
    // recordVideo are false), so asking for this consent would state processing
    // that does not happen. The practice sheet keeps saying video is not
    // offered. Change this to 'always' only together with CN L-11.
    type: 'interview_video',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'never',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      zh: '在面试练习中录制我的摄像头画面，并与录音一起保存，供我回看。保存 90 天后自动删除。未开启时不会录制摄像头画面。',
      en: 'Record video from my camera during practice interviews and keep it with the audio so I can review it. It is deleted automatically after 90 days. When this is off, my camera is never recorded.',
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
  {
    // Optional and off until the user turns it on (no regional default on
    // GoApply). GoApply serves Chinese and English only.
    type: 'tips_reminders',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: { en: TIPS_REMINDERS_PROSE.en, zh: TIPS_REMINDERS_PROSE.zh },
  },
  {
    // PIPL Art. 23: a separate consent before personal information goes to
    // another handler. Asked on the coaching request form, per request; the
    // coach is named on that form. DRAFT wording — counsel writes the final text.
    //
    // `appliesWhen: 'never'`: the wording speaks of "this coaching request", so
    // it is not a standalone switch on the consents panel. The coaching form
    // records it (recordConsent); the panel lists it only after that, so the
    // user can see and withdraw it.
    type: 'coaching_share_with_coach',
    brand: 'goapply',
    requiredWhen: 'never',
    appliesWhen: 'never',
    stage: 'in_context',
    control: 'checkbox',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    proseStatus: 'draft',
    prose: {
      zh:
        '我同意 %BRAND% 把这份辅导申请中的姓名、邮箱和留言发送给我选择的独立教练，仅用于回复我的申请。' +
        '教练不是 %BRAND% 的员工，会按照自己的规则处理这些信息。撤回后不再发送新的申请；已经发送的申请由教练处理。',
      en:
        'I agree that %BRAND% sends the name, email address and message in this coaching request to the independent coach I chose, only so they can reply to it. ' +
        'The coach does not work for %BRAND% and handles this information under their own rules. Withdrawing stops new requests from being sent; requests already sent stay with the coach.',
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
    // See the GoApply entry: without this live grant the camera is never recorded.
    type: 'interview_video',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      en: 'Record video from my camera during practice interviews and keep it with the audio so I can review it. It is deleted automatically after 90 days. When this is off, my camera is never recorded.',
    },
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
    // See the GoApply entry: gates `sensitiveForAutofill` (WP-19 → WP-55a). Wave 2 gate.
    type: 'autofill_sensitive',
    brand: 'roboapply',
    requiredWhen: 'never',
    appliesWhen: 'always',
    stage: 'in_context',
    control: 'toggle',
    withdrawable: true,
    onWithdraw: 'none',
    defaultGranted: false,
    prose: {
      en: 'Let the %BRAND% browser extension fill my sensitive answers (voluntary self-identification such as gender, race or ethnicity, veteran and disability status) into application forms I open myself, for me to check and submit. They are never used for matching or AI processing. Turning this off stops the extension from filling them.',
    },
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
    // A notification choice shown in the notification settings, among translated
    // text: written in every locale (other entries stay English until counsel approves a translation).
    prose: TIPS_REMINDERS_PROSE,
  },
];

// ── Context ────────────────────────────────────────────────────────────────

export interface ConsentContext {
  env?: EnvSource;
  /** Visitor/user country (ISO alpha-2), for the Taiwan notice. */
  country?: string | null;
  locale?: string | null;
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
  /** The language of `text` (the value hashed): the locale asked for when the entry has that text, else English. */
  locale: ConsentProseLocale;
  /** Same value as `locale` (kept for callers written while `locale` was still typed 'en' | 'zh'). */
  proseLocale: ConsentProseLocale;
  version: string;
  hash: string;
}

/**
 * The locale whose prose is served: the one asked for when the entry is
 * written in it, else English. No locale given = the brand's default language.
 */
export function proseLocaleFor(def: ConsentDefinition, locale: string | null | undefined, brand?: Pick<ProductBrand, 'defaultLocale'>): ConsentProseLocale {
  const asked = locale ?? brand?.defaultLocale ?? 'en';
  const hit = CONSENT_PROSE_LOCALES.find((l) => l === asked);
  return hit && def.prose[hit] ? hit : 'en';
}

export function consentProseHash(input: { brand: BrandId; type: string; version: string; locale: string; text: string }): string {
  return crypto
    .createHash('sha256')
    .update([input.brand, input.type, input.version, input.locale, input.text].join('\n'))
    .digest('hex');
}

/**
 * The text served for an entry: brand name, and — where the prose asks for
 * them — the offshore processors and the AI destination of THIS deployment
 * (`env`), the same facts the /legal disclosures render.
 */
/** The text of an entry in one of the languages it is written in, as this deployment serves it. */
function consentProseText(def: ConsentDefinition, brand: ProductBrand, lang: ConsentProseLocale, env: EnvSource): string {
  let text = (def.prose[lang] ?? def.prose.en).split('%BRAND%').join(brand.name);
  if (text.includes(OFFSHORE_PROCESSORS_TOKEN)) text = text.split(OFFSHORE_PROCESSORS_TOKEN).join(offshoreProcessorsSentence(brand, env, lang));
  if (text.includes(AI_PLACE_TOKEN)) text = text.split(AI_PLACE_TOKEN).join(aiPlaceSentence(brand, env, lang));
  return text;
}

/**
 * Whether a stored answer was given to the text this deployment serves now.
 * The record's hash covers brand, type, version, locale and text, so it is
 * recomputed with the record's OWN version over today's text in each language
 * the entry is written in: a version bump that left this entry's words alone
 * still matches, a reworded entry (or a changed processor list) does not.
 *
 * A record without a hash or version cannot be compared with any text, so the
 * answer is null (unknown), never false: nothing shows that the text changed,
 * and a screen must not say it did (D3). Such records come from sign-up forms
 * that stored no hash (RoboApply sign-up; GoApply phone and WeChat sign-up
 * before the Wave FIX gate).
 */
export function answeredCurrentText(
  def: ConsentDefinition,
  brand: ProductBrand,
  record: { proseHash?: string | null; proseVersion?: string | null },
  env: EnvSource = process.env,
): boolean | null {
  if (!record.proseHash || !record.proseVersion) return null;
  return CONSENT_PROSE_LOCALES.some(
    (lang) =>
      typeof def.prose[lang] === 'string' &&
      consentProseHash({ brand: brand.id, type: def.type, version: record.proseVersion!, locale: lang, text: consentProseText(def, brand, lang, env) }) === record.proseHash,
  );
}

export function resolveConsentProse(
  def: ConsentDefinition,
  brand: ProductBrand,
  locale: string | null | undefined,
  env: EnvSource = process.env,
): ResolvedProse {
  const lang = proseLocaleFor(def, locale, brand);
  const text = consentProseText(def, brand, lang, env);
  return {
    text,
    locale: lang,
    proseLocale: lang,
    version: CONSENT_PROSE_VERSION,
    hash: consentProseHash({ brand: brand.id, type: def.type, version: CONSENT_PROSE_VERSION, locale: lang, text }),
  };
}

/**
 * The text this deployment serves for an entry whose hash is `hash`, in
 * whichever language the entry is written in: the text a form showed when it
 * sends that hash back. Null when the hash is absent or matches no served
 * text (the wording, or the processor list in it, changed since).
 */
export function servedConsentProseByHash(
  def: ConsentDefinition,
  brand: ProductBrand,
  hash: string | null | undefined,
  env: EnvSource = process.env,
): ResolvedProse | null {
  if (!hash) return null;
  for (const lang of CONSENT_PROSE_LOCALES) {
    if (typeof def.prose[lang] !== 'string') continue;
    const prose = resolveConsentProse(def, brand, lang, env);
    if (prose.hash === hash) return prose;
  }
  return null;
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
    select: { consentType: true, granted: true, createdAt: true, proseVersion: true, proseHash: true },
  });
  const latest = new Map<string, { granted: boolean; createdAt: Date; proseVersion: string | null; proseHash: string | null }>();
  for (const r of records) if (!latest.has(r.consentType)) latest.set(r.consentType, r);

  const fullCtx = { ...ctx, env: ctx.env ?? deps.env };
  const env = fullCtx.env ?? process.env;
  return defs
    .filter((d) => isConsentApplicable(d, fullCtx) || latest.has(d.type))
    .map((d) => {
      const prose = resolveConsentProse(d, brand, ctx.locale, env);
      const rec = latest.get(d.type);
      return {
        type: d.type,
        required: isConsentRequired(d, fullCtx),
        stage: d.stage,
        control: d.control,
        withdrawable: d.withdrawable,
        onWithdraw: d.onWithdraw === 'close_and_purge_account' && isOffshore(env) ? d.onWithdraw : 'none',
        defaultGranted: false as const,
        prose: prose.text,
        proseVersion: prose.version,
        proseHash: prose.hash,
        proseLocale: prose.proseLocale,
        granted: rec ? rec.granted : null,
        answeredAt: rec ? rec.createdAt.toISOString() : null,
        // Which text the answer was given to: a screen must not show today's words as "what you agreed to" when they differ.
        answeredProseVersion: rec ? (rec.proseVersion ?? null) : null,
        answeredTextCurrent: rec ? answeredCurrentText(d, brand, rec, env) : null,
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

  const prose = resolveConsentProse(def, input.brand, input.locale, env);
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
