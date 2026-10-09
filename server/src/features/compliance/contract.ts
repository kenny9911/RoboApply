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

// ── GET /compliance/disclosures ──────────────────────────────────────────

export interface AiModelDisclosure {
  /** Task family the model serves (assistant, tailoring, practice, …). */
  task: string;
  /** Vendor and model as configured; never guessed. */
  vendor: string;
  model: string;
  /** Country/region of the processing endpoint. */
  region: string | null;
}
export interface DisclosuresResponse {
  models: AiModelDisclosure[];
  /** Filing / licence numbers, only those set in env (GoApply). */
  filings: Partial<Record<'icp' | 'psb' | 'edi' | 'hrLicence' | 'genaiRegistration', string>>;
  /** Offshore processors named in the CN-0 notice (GoApply) or transfer countries (RoboApply). */
  processors: Array<{ name: string; purpose: string; country: string }>;
}

// ── Personal-information requests (PIPL Art. 44–47; GDPR; TW PDPA) ───────

export const PI_REQUEST_KINDS = ['access', 'copy', 'correction', 'deletion', 'portability', 'withdraw_consent', 'explanation'] as const;
export type PiRequestKind = (typeof PI_REQUEST_KINDS)[number];
export const PI_REQUEST_STATUSES = ['open', 'in_progress', 'done', 'rejected'] as const;

/** Due dates: 15 working days on GoApply, 30 days on RoboApply (WP-13). */
export const PI_REQUEST_DUE = { goapplyWorkingDays: 15, roboapplyDays: 30 } as const;

export const CreatePiRequestBodySchema = z
  .object({ kind: z.enum(PI_REQUEST_KINDS), detail: z.string().max(4000).optional() })
  .strict();
export interface PiRequestView {
  id: string;
  kind: PiRequestKind;
  status: (typeof PI_REQUEST_STATUSES)[number];
  dueAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

/** `RAPersonalInfoRequest.detail` (documented JSON column): request detail and handling notes, no copies of exported data. */
export const PiRequestDetailSchema = z
  .object({
    userNote: z.string().optional(),
    handlingNotes: z.array(z.object({ at: z.string(), by: z.string(), note: z.string() })).optional(),
  })
  .passthrough();

/** `RAContentSafetyEvent.matched` (documented JSON column): provider labels / matched rule ids; no raw user text. */
export const ContentSafetyMatchedSchema = z
  .object({ labels: z.array(z.string()).optional(), ruleIds: z.array(z.string()).optional(), listVersion: z.string().optional() })
  .passthrough();

// ── POST /compliance/export (data export → emailed link) ─────────────────

export interface ExportRequestResponse {
  /** Queue item id of the `compliance.export` job. */
  exportId: string;
  status: 'queued';
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
  provider: string;
  brand: string;
  contentId: string;
  generatedAt: string;
}

export const COMPLIANCE_ERROR_CODES = {
  docNotPublished: 'legal_doc_not_published',
  requestOpen: 'pi_request_already_open',
} as const;
