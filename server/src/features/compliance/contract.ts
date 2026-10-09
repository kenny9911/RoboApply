// server/src/features/compliance/contract.ts
//
// Consents, legal documents, personal-information requests, AI labelling and
// the legal footer (TASK_PLAN.md WP-13; CN_TW_LAUNCH_PLAN.md CN-E-04,
// CN-E-07, CN-L-09). Mounts: /compliance (seeker), /api/v1/public/legal
// (public) and /admin/compliance (admin).
//
// D3: filing numbers, entity names and model disclosures come only from env;
// nothing is shown that ops has not configured. Documents stay DRAFT until
// counsel approves them.

import { z } from 'zod';

// ── GET /compliance/disclosures (also public: /api/v1/public/legal/disclosures) ──

/** What a processor does for us; the UI translates the code (legal.processors.<purpose>). */
export const PROCESSOR_PURPOSES = ['database', 'hosting', 'email', 'voice', 'speech', 'payments', 'ai_models', 'storage'] as const;
export type ProcessorPurpose = (typeof PROCESSOR_PURPOSES)[number];

export interface AiModelDisclosure {
  /** Task family the model serves (default, assistant, tailoring, practice, …). */
  task: string;
  /** Vendor and model as configured; never guessed. */
  vendor: string;
  model: string;
  /** ISO country of the vendor's processing endpoint; null when we do not know it ("Not listed"). */
  region: string | null;
  /** Filing number of the model (GoApply, from CN_GENAI_DISCLOSURES); null when none is set. */
  filingNo: string | null;
}
export interface DisclosuresResponse {
  brand: string;
  models: AiModelDisclosure[];
  /** Filing / licence numbers, only those set in env (GoApply). */
  filings: Partial<Record<'icp' | 'psb' | 'edi' | 'hrLicence' | 'genaiRegistration' | 'algorithmFiling', string>>;
  /** Offshore processors named in the CN-0 notice (GoApply) or transfer countries (RoboApply). Derived from configuration. */
  processors: Array<{ name: string; purpose: ProcessorPurpose; country: string | null; region: string | null }>;
  /** GoApply CN-0: data is processed outside the mainland (DEPLOY_REGION != cn-mainland). */
  offshore: boolean;
  /** CN_GENAI_STATUS_NOTE verbatim, only when ops set it; never invented. */
  statusNote: string | null;
}

// ── GET /api/v1/public/legal/footer ──────────────────────────────────────

export interface LegalFooterLink {
  doc: LegalDoc;
  href: string;
}
/** The legal footer, every value from env (D3); absent values are simply missing. */
export interface LegalFooterModel {
  brand: string;
  market: 'intl' | 'cn';
  entity: string | null;
  links: LegalFooterLink[];
  icp: { number: string; url: string } | null;
  psb: { number: string; url: string | null } | null;
  edi: string | null;
  hrLicence: { number: string; holder: string } | null;
  /** Configured models (name shown as soon as configured) with filing numbers only when set. */
  aiModels: Array<{ vendor: string; model: string; filingNo: string | null }>;
  genaiRegistration: string | null;
  algorithmFiling: string | null;
  statusNote: string | null;
  complaints: { email: string | null; phone: string | null } | null;
}

/** Fixed regulator URLs (CN plan WP-COMPLY acceptance). */
export const ICP_LOOKUP_URL = 'https://beian.miit.gov.cn/';
export const PSB_LOOKUP_URL_PREFIX = 'https://beian.mps.gov.cn/#/query/webSearch?code=';

// ── Personal-information requests (PIPL Art. 44–47; GDPR; TW PDPA) ───────

export const PI_REQUEST_KINDS = ['access', 'copy', 'correction', 'deletion', 'portability', 'withdraw_consent', 'explanation'] as const;
export type PiRequestKind = (typeof PI_REQUEST_KINDS)[number];
export const PI_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'rejected'] as const;
export type PiRequestStatus = (typeof PI_REQUEST_STATUSES)[number];

/** Due dates: 15 working days on GoApply, 30 days on RoboApply (WP-13). */
export const PI_REQUEST_DUE = { goapplyWorkingDays: 15, roboapplyDays: 30 } as const;

export const CreatePiRequestBodySchema = z
  .object({ kind: z.enum(PI_REQUEST_KINDS), detail: z.string().max(4000).optional() })
  .strict();
export interface PiRequestView {
  id: string;
  kind: PiRequestKind;
  status: PiRequestStatus;
  dueAt: string;
  createdAt: string;
  resolvedAt: string | null;
  /** A finished data export the user can still download (until `expiresAt`); null otherwise. */
  download: { expiresAt: string; bytes: number } | null;
}
/** Admin view: adds the brand, the subject and the overdue flag. */
export interface AdminPiRequestView extends PiRequestView {
  brand: string;
  userId: string | null;
  overdue: boolean;
  userNote: string | null;
  handlingNotes: Array<{ at: string; by: string; note: string }>;
}
export const AdminPiRequestParamsSchema = z.object({ id: z.string().min(1).max(64) });
export const AdminUpdatePiRequestBodySchema = z
  .object({ status: z.enum(PI_REQUEST_STATUSES).optional(), note: z.string().min(1).max(2000).optional() })
  .strict()
  .refine((b) => b.status !== undefined || b.note !== undefined, { message: 'status or note is required' });

/** `RAPersonalInfoRequest.detail` (documented JSON column): request detail and handling notes, no copies of exported data. */
export const PiRequestDetailSchema = z
  .object({
    userNote: z.string().optional(),
    handlingNotes: z.array(z.object({ at: z.string(), by: z.string(), note: z.string() })).optional(),
    /** Why the system opened the request (e.g. 'pipl_cross_border_withdrawn'). */
    reason: z.string().optional(),
    /** A built data export (kind copy/portability): where the file is, until it expires. */
    export: z
      .object({ provider: z.string(), key: z.string(), bytes: z.number(), expiresAt: z.string(), purgedAt: z.string().optional() })
      .optional(),
  })
  .passthrough();
export type PiRequestDetail = z.infer<typeof PiRequestDetailSchema>;

/** `RAContentSafetyEvent.matched` (documented JSON column): provider labels / matched rule ids; no raw user text. */
export const ContentSafetyMatchedSchema = z
  .object({ labels: z.array(z.string()).optional(), ruleIds: z.array(z.string()).optional(), listVersion: z.string().optional() })
  .passthrough();

// ── POST /compliance/export (data export → in-app download + email) ─────

export interface ExportRequestResponse {
  /** Queue item id of the `compliance.export` job. */
  exportId: string;
  /** The personal-information request that tracks it (kind `copy`, or `portability` when filed as that). */
  requestId: string;
  status: 'queued';
}
export const ExportDownloadParamsSchema = z.object({ id: z.string().min(1).max(64) });
/** Days a built export stays downloadable before compliance-daily deletes the file. */
export const DATA_EXPORT_TTL_DAYS = 7;

// ── Consents (/compliance/consents; prose served with its version + hash) ──

export const CONSENT_CONTROLS = ['checkbox', 'toggle', 'two_option'] as const;
export interface ConsentCatalogItem {
  type: string;
  /** Required to use the product at all (signup); CN-0 adds `pipl_cross_border`. */
  required: boolean;
  /** Asked at signup, or in context when the feature is first used. */
  stage: 'signup' | 'in_context';
  control: (typeof CONSENT_CONTROLS)[number];
  /** False for consents that can only end by deleting the account (the agreement, age). */
  withdrawable: boolean;
  /** What withdrawing does beyond recording it. */
  onWithdraw: 'none' | 'close_and_purge_account';
  /** Never true: no optional consent is pre-checked (PIPL; PRODUCT §4.5). */
  defaultGranted: false;
  /** The exact text shown; its version and hash are stored with the record. */
  prose: string;
  proseVersion: string;
  proseHash: string;
  /** Locale of the prose actually served (English when no translation exists). */
  proseLocale: string;
  /** Current state: null = never answered. */
  granted: boolean | null;
  answeredAt: string | null;
}
export interface ConsentsResponse {
  items: ConsentCatalogItem[];
}
export const ConsentsQuerySchema = z.object({ locale: z.string().max(8).optional() });
export const RecordConsentBodySchema = z
  .object({
    type: z.string().min(1).max(60),
    granted: z.boolean(),
    proseVersion: z.string().min(1).max(40),
    locale: z.string().max(8).optional(),
  })
  .strict();
export interface RecordConsentResponse {
  type: string;
  granted: boolean;
  proseVersion: string;
  proseHash: string;
  at: string;
  /** Set when the withdrawal closes the account (CN-0 cross-border consent). */
  accountClosing: boolean;
}

// ── PIPL Art. 24 explanation (explainMatch) ──────────────────────────────

/** One line of the "Why this job" explanation: a message key under `legal.explain.*` plus params. */
export interface ExplainLine {
  key: string;
  params?: Record<string, string | number>;
}
export interface MatchExplanation {
  /** 'personalized' = ranked with the profile; 'non_personalized' = recency + filters only. */
  mode: 'personalized' | 'non_personalized';
  headline: ExplainLine;
  reasons: ExplainLine[];
  gaps: ExplainLine[];
  /** Always present: what the score is not, and how to switch personalisation off. */
  notices: ExplainLine[];
}

// ── Retention schedule (published in both privacy notices) ───────────────

export interface RetentionRuleView {
  id: string;
  /** Amount + unit; null when the period is set outside our code and not configured ("Not listed"). */
  keep: { amount: number; unit: 'hours' | 'days' | 'months' } | null;
  /** Who runs the deletion: this cron, another named job, or the infrastructure provider. */
  enforcedBy: 'compliance-daily' | 'account-purge' | 'interview-retention' | 'provider' | 'not_automated';
}

// ── GET /api/v1/public/legal/:doc ────────────────────────────────────────

/** intl: terms, privacy, cookies, refunds, subscription-terms, ai-disclosure, tw-pdpa-notice; cn: 用户协议 … 投诉举报. */
export const LEGAL_DOCS = [
  'terms',
  'privacy',
  'cookies',
  'refunds',
  'subscription-terms',
  'ai-disclosure',
  'tw-pdpa-notice',
  'pi-collection-list',
  'third-party-sharing',
  'ai-content-labels',
  'complaints',
  'referral-terms',
  'coaching',
] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/**
 * Which file serves a document on each market (content/legal/<market>/<file>.md).
 * A document missing for a market answers 404 there. `referral-terms` and
 * `coaching` belong to WP-60 / WP-72 (their files may not exist yet).
 */
export const LEGAL_DOC_FILES: Record<'intl' | 'cn', Partial<Record<LegalDoc, string>>> = {
  intl: {
    terms: 'terms',
    privacy: 'privacy',
    cookies: 'cookies',
    refunds: 'refunds',
    'subscription-terms': 'subscription-terms',
    'ai-disclosure': 'ai-disclosure',
    'tw-pdpa-notice': 'tw-pdpa-notice',
    'referral-terms': 'referral-terms',
    coaching: 'coaching',
  },
  cn: {
    terms: 'user-agreement',
    privacy: 'privacy',
    'pi-collection-list': 'pi-collection-list',
    'third-party-sharing': 'third-party-sharing',
    'ai-content-labels': 'ai-content-labels',
    complaints: 'complaints',
    'referral-terms': 'referral-terms',
  },
};

/** Older/alternative slugs (PRODUCT_PLAN §3.2 GoApply routes) → the canonical slug. */
export const LEGAL_DOC_ALIASES: Readonly<Record<string, LegalDoc>> = {
  agreement: 'terms',
  'user-agreement': 'terms',
  'personal-info-list': 'pi-collection-list',
  'ai-content-labelling': 'ai-content-labels',
};

/** Per-market aliases: on GoApply the AI disclosure is the 标识说明 document. */
export const LEGAL_DOC_MARKET_ALIASES: Record<'intl' | 'cn', Partial<Record<LegalDoc, LegalDoc>>> = {
  intl: {},
  cn: { 'ai-disclosure': 'ai-content-labels' },
};

/**
 * Resolve a requested slug for a market: `{ doc, file }` for a served
 * document, `{ redirect }` when the slug is an alias of another one, or null.
 */
export function resolveLegalDocSlug(
  market: 'intl' | 'cn',
  slug: string,
): { doc: LegalDoc; file: string } | { redirect: LegalDoc } | null {
  const alias = LEGAL_DOC_ALIASES[slug] ?? (LEGAL_DOC_MARKET_ALIASES[market] as Record<string, LegalDoc | undefined>)[slug];
  if (alias) return LEGAL_DOC_FILES[market][alias] ? { redirect: alias } : null;
  if (!(LEGAL_DOCS as readonly string[]).includes(slug)) return null;
  const doc = slug as LegalDoc;
  const file = LEGAL_DOC_FILES[market][doc];
  return file ? { doc, file } : null;
}

/** Footer link order per market (only documents this WP owns). */
export const LEGAL_FOOTER_DOCS: Record<'intl' | 'cn', LegalDoc[]> = {
  intl: ['terms', 'privacy', 'cookies', 'ai-disclosure', 'subscription-terms', 'refunds'],
  cn: ['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints'],
};
export const LegalDocParamsSchema = z.object({ doc: z.enum(LEGAL_DOCS) });
export const LegalDocQuerySchema = z.object({ locale: z.string().max(8).optional() });
export interface LegalDocResponse {
  doc: LegalDoc;
  locale: string;
  version: string | null;
  /** True until counsel approves the text. */
  draft: boolean;
  markdown: string;
  updatedAt: string | null;
}

// ── Admin: GET /admin/compliance/pi-requests ─────────────────────────────

export const AdminPiRequestsQuerySchema = z.object({
  status: z.enum(PI_REQUEST_STATUSES).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(64).optional(),
});

// ── AI labelling (aiLabel.ts) ────────────────────────────────────────────

/** Implicit (machine-readable) AI-generated label written into exports (CN-E-07; EU AI Act Art. 50(2)). */
export interface ImplicitAiLabel {
  aiGenerated: true;
  /** The model vendor that generated the content. */
  provider: string;
  /** The service (our brand) that produced the content. */
  producer: string;
  brand: string;
  contentId: string;
  generatedAt: string;
  /** PDF document-info keys (Info dictionary). */
  pdfInfo: Record<string, string>;
  /** DOCX custom properties (docProps/custom.xml). */
  docxCustomProperties: Record<string, string>;
  /** XMP packet fragment with the same marks, for PDF metadata streams. */
  xmp: string;
}

export const AI_LABEL_ARTIFACT_TYPES = ['resume', 'cover_letter', 'assistant_message', 'practice_report', 'tailored_resume', 'answer', 'other'] as const;

export const COMPLIANCE_ERROR_CODES = {
  docNotPublished: 'legal_doc_not_published',
  requestOpen: 'pi_request_already_open',
  consentUnknown: 'consent_unknown',
  consentNotWithdrawable: 'consent_not_withdrawable',
  proseOutdated: 'consent_prose_outdated',
  exportExpired: 'export_expired',
} as const;
