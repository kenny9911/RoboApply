// lib/api/admin.ts
//
// Typed client for the RoboApply admin analytics + profitability surface
// (backend: backend/src/roboapply routes mounted at
// `/api/v1/roboapply/v2/admin/*`). Admin-only — the page gates on
// `User.role === 'admin'` before any of these are called.
//
// Every read takes a `{ from, to, tz }` range (ISO dates + IANA tz). All calls
// route through `roboApi` (lib/api/client.ts), which attaches the session
// cookie / Bearer fallback, unwraps the `{ success, data }` envelope (returns
// `data`), and throws `RoboApiError` (`.code` / `.message`). For the CSV
// download links we build the URL by hand with `API_BASE` (anchor href, not a
// fetch) — see `adminCsvUrl()`.

import { roboApi } from './client';
import { API_BASE } from '../config';
import { apiUrl, call, seg, withQuery, type CallOptions, type In } from './contracts/wire';
import type * as AD from './contracts/admin';
import type * as CR from './contracts/cn/referrals';
import type { RefundQuoteResponse } from './contracts/credits';

const BASE = '/api/v1/roboapply/v2/admin';

export type AdminTier = 'free' | 'premium' | 'premium_plus';

/** A resolved date range. `from`/`to` are ISO date strings, `tz` is an IANA
 *  zone (e.g. "America/New_York"). All admin reads accept this shape. */
export interface AdminRange {
  from?: string;
  to?: string;
  tz?: string;
}

// ── Overview ──────────────────────────────────────────────────────────

export interface AdminOverviewKpis {
  activeUsers: number;
  sessions: number;
  totalCostUsd: number;
  sharedCostUsd: number;
  mrrUsd: number | null;
  monthlyCostRunRateUsd: number;
  grossMarginUsd: number | null;
  grossMarginPct: number | null;
  costPerActiveUserUsd: number;
  payingUsers: number;
}

export interface AdminCostByFeature {
  key: string;
  label: string;
  costUsd: number;
  units: number;
}

export interface AdminCostByModality {
  modality: string;
  label: string;
  costUsd: number;
}

export interface AdminCostSeriesPoint {
  day: string;
  costUsd: number;
  revenueRunRateUsd: number | null;
}

export interface AdminMrrByTierEntry {
  count: number;
  mrrUsd: number | null;
}

export interface AdminOverviewResponse {
  range: { from: string; to: string; tz: string };
  kpis: AdminOverviewKpis;
  mrrByTier: Record<string, AdminMrrByTierEntry>;
  costByFeature: AdminCostByFeature[];
  costByModality: AdminCostByModality[];
  costSeries: AdminCostSeriesPoint[];
}

// ── Users list ────────────────────────────────────────────────────────

export type AdminUsersSort =
  | 'marginUsd'
  | 'mrrUsd'
  | 'periodCostUsd'
  | 'sessions'
  | 'lastActiveAt'
  | 'email'
  | 'tier';

export interface AdminUsersParams extends AdminRange {
  q?: string;
  sort?: AdminUsersSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  tier?: AdminTier; // client-side convenience filter param
}

export interface AdminUserRow {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  tier: string;
  status: string;
  mrrUsd: number | null;
  periodCostUsd: number;
  marginUsd: number | null;
  marginPct: number | null;
  profitable: boolean | null;
  sessions: number;
  interviewDebits: number;
  lastActiveAt: string | null;
  hasStripeCustomer: boolean;
  currentPeriodEnd: string | null;
}

export interface AdminUsersResponse {
  rows: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
}

// ── User detail ───────────────────────────────────────────────────────

export interface AdminUserDetailUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  provider: string | null;
  createdAt: string;
}

export interface AdminUserDetailSubscription {
  tier: string;
  status: string;
  mrrUsd: number | null;
  amountMinor: number | null;
  currency: string | null;
  dailyCap: number | null;
  stripeCustomerId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface AdminUserDetailProfitability {
  lifetimeCostUsd: number;
  periodCostUsd: number;
  mrrUsd: number | null;
  marginUsd: number | null;
  marginPct: number | null;
  profitable: boolean | null;
}

export interface AdminDailyUsagePoint {
  day: string;
  costUsd: number;
  count: number;
}

export interface AdminSessionCostBreakdown {
  blueprint?: number;
  liveLlm?: number;
  stt?: number;
  tts?: number;
  evaluation?: number;
  coach?: number;
  recording?: number;
  total?: number;
  // tolerate extra keys without a type error
  [k: string]: number | undefined;
}

export interface AdminUserInterviewSession {
  id: string;
  role: string | null;
  status: string;
  durationSec: number | null;
  costUsd: number;
  createdAt: string;
  cost: {
    llm?: number;
    stt?: number;
    tts?: number;
    recording?: number;
    [k: string]: number | undefined;
  };
}

export interface AdminUserDetailResponse {
  user: AdminUserDetailUser;
  subscription: AdminUserDetailSubscription;
  profitability: AdminUserDetailProfitability;
  costByFeature: AdminCostByFeature[];
  dailyUsage: AdminDailyUsagePoint[];
  interviewSessions: AdminUserInterviewSession[];
}

// ── Set plan ──────────────────────────────────────────────────────────

export interface AdminSetPlanBody {
  tier: AdminTier;
  amountMinor?: number;
  currency?: string;
  reason: string;
}

export interface AdminSetPlanResponse {
  ok: true;
  tier: string;
  amountMinor: number | null;
}

// ── Sessions list ─────────────────────────────────────────────────────

export interface AdminSessionsParams extends AdminRange {
  userId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminSessionRow {
  id: string;
  userId: string;
  email: string | null;
  role: string | null;
  status: string;
  durationSec: number | null;
  costUsd: number;
  createdAt: string;
  cost: {
    blueprint?: number;
    liveLlm?: number;
    stt?: number;
    tts?: number;
    evaluation?: number;
    coach?: number;
    recording?: number;
    total?: number;
    [k: string]: number | undefined;
  };
}

export interface AdminSessionsResponse {
  rows: AdminSessionRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminSessionDetailResponse {
  id: string;
  userId: string;
  role: string | null;
  interviewType: string | null;
  mode: string | null;
  language: string | null;
  status: string;
  durationSec: number | null;
  recordingDurationSec: number | null;
  recordingBytes: number | null;
  costUsd: number;
  costBreakdown: AdminSessionCostBreakdown | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  overall: number | null;
  createdAt: string;
  endedAt: string | null;
  user: { email: string | null; name: string | null };
}

// ── Rate card ─────────────────────────────────────────────────────────

export interface AdminLlmRate {
  input: number;
  output: number;
}

export interface AdminRateCardTier {
  priceUsdMonthly: number;
  dailyCap: number;
  stripePriceId: string | null;
}

export interface AdminRateCard {
  llm: Record<string, AdminLlmRate>;
  llmDefault: AdminLlmRate;
  stt: { default: number; byModelSubstring?: Record<string, number> };
  tts: { usdPer1MChars: number; usdPerMin: number };
  egress: { usdPerGb: number };
  storage: { usdPerGbMonth: number };
  tiers: Record<AdminTier, AdminRateCardTier>;
}

export interface AdminRateCardResponse {
  card: AdminRateCard;
  source: 'db' | 'env';
  cacheAgeMs: number | null;
}

// ── Querystring helper ────────────────────────────────────────────────
//
// Mirrors the `qs()` helper in lib/api/v2/_real.ts: drops undefined/null,
// returns a leading `?` only when non-empty.
function qs(params?: object): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val === undefined || val === null || val === '') continue;
    usp.append(key, String(val));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// ── API surface ───────────────────────────────────────────────────────

export const adminApi = {
  overview: (params?: AdminRange) =>
    roboApi.get<AdminOverviewResponse>(`${BASE}/overview${qs(params)}`),

  users: (params?: AdminUsersParams) =>
    roboApi.get<AdminUsersResponse>(`${BASE}/users${qs(params)}`),

  user: (userId: string, params?: AdminRange) =>
    roboApi.get<AdminUserDetailResponse>(
      `${BASE}/users/${encodeURIComponent(userId)}${qs(params)}`,
    ),

  setPlan: (userId: string, body: AdminSetPlanBody) =>
    roboApi.post<AdminSetPlanResponse>(
      `${BASE}/users/${encodeURIComponent(userId)}/plan`,
      body,
    ),

  sessions: (params?: AdminSessionsParams) =>
    roboApi.get<AdminSessionsResponse>(`${BASE}/sessions${qs(params)}`),

  session: (id: string) =>
    roboApi.get<AdminSessionDetailResponse>(
      `${BASE}/sessions/${encodeURIComponent(id)}`,
    ),

  rateCard: () => roboApi.get<AdminRateCardResponse>(`${BASE}/rate-card`),
};

/** Build a fully-qualified CSV download URL for an anchor `href`. Uses
 *  `API_BASE` (empty in dev → Next rewrite; the API host in prod). `which`
 *  selects `users.csv` or `sessions.csv`. */
export function adminCsvUrl(
  which: 'users' | 'sessions',
  params?: AdminUsersParams | AdminSessionsParams,
): string {
  return `${API_BASE}${BASE}/${which}.csv${qs(params)}`;
}

// ── Admin console additions (WP-74) ────────────────────────────────────
//
// Thin typed wrappers over server/src/features/admin/contract.ts (mounted at
// /api/v1/roboapply/admin), plus the admin endpoints of other areas this
// console renders: the GoApply referral-code queue (WP-54) and the refund
// quote (WP-21a). Personal-information requests use lib/api/compliance.ts.
//
// Endpoints:
//   GET    /api/v1/roboapply/admin/system
//   GET    /api/v1/roboapply/admin/system/queue
//   POST   /api/v1/roboapply/admin/system/queue/:id/retry
//   GET    /api/v1/roboapply/admin/system/audit   (admin actions, RAAdminAuditLog)
//   GET    /api/v1/roboapply/admin/costs          (+ costs.csv, browser download)
//   GET    /api/v1/roboapply/admin/safety
//   GET    /api/v1/roboapply/admin/reports
//   POST   /api/v1/roboapply/admin/reports/:id/resolve
//   GET    /api/v1/roboapply/admin/overrides
//   POST   /api/v1/roboapply/admin/overrides
//   DELETE /api/v1/roboapply/admin/overrides/:id
//   GET    /api/v1/roboapply/admin/copilot-feedback
//   GET    /api/v1/roboapply/admin/cn/referrals/queue
//   POST   /api/v1/roboapply/admin/referrals/:id/moderate   (WP-54 service + audit row)
//   GET    /api/v1/roboapply/admin/credits/refund-quote
// Held invite rewards (WP-60) use lib/api/growth.ts (listHeldReferrals / reviewReferral).


const CONSOLE = '/api/v1/roboapply/admin';

export type {
  AdminAuditResponse,
  AdminAuditView,
  AdminFeedbackItem,
  AdminFeedbackResponse,
  AdminOverrideView,
  AdminOverridesResponse,
  AlertHit,
  AlertKey,
  BrandHealth,
  CostRow,
  CostsResponse,
  JobSourceRunView,
  JobSourceView,
  ProviderUsageRow,
  QueueKindRow,
  ReportItem,
  ReportsResponse,
  ResolveDecision,
  SafetyEventView,
  SafetyResponse,
  SystemStatusResponse,
  WorkItemView,
  WorkItemsResponse,
} from './contracts/admin';
export type { ReferralQueueItem, ReferralQueueResponse } from './contracts/cn/referrals';
export type { RefundQuoteResponse } from './contracts/credits';

/** `admin.system` — GET /api/v1/roboapply/admin/system */
export function getSystemStatus(query?: In<typeof AD.SystemQuerySchema>, opts?: CallOptions): Promise<AD.SystemStatusResponse> {
  return call<AD.SystemStatusResponse>('GET', withQuery(`${CONSOLE}/system`, query), opts);
}

/** `admin.queue` — GET /api/v1/roboapply/admin/system/queue */
export function listWorkItems(query?: In<typeof AD.QueueListQuerySchema>, opts?: CallOptions): Promise<AD.WorkItemsResponse> {
  return call<AD.WorkItemsResponse>('GET', withQuery(`${CONSOLE}/system/queue`, query), opts);
}

/** `admin.retryWorkItem` — POST /api/v1/roboapply/admin/system/queue/:id/retry */
export function retryWorkItem(id: string, opts?: CallOptions): Promise<AD.RetryWorkItemResponse> {
  return call<AD.RetryWorkItemResponse>('POST', `${CONSOLE}/system/queue/${seg(id)}/retry`, opts);
}

/** `admin.audit` — GET /api/v1/roboapply/admin/system/audit */
export function listAdminAudit(query?: In<typeof AD.AdminAuditQuerySchema>, opts?: CallOptions): Promise<AD.AdminAuditResponse> {
  return call<AD.AdminAuditResponse>('GET', withQuery(`${CONSOLE}/system/audit`, query), opts);
}

/** `admin.costs` — GET /api/v1/roboapply/admin/costs */
export function getCosts(query?: In<typeof AD.CostsQuerySchema>, opts?: CallOptions): Promise<AD.CostsResponse> {
  return call<AD.CostsResponse>('GET', withQuery(`${CONSOLE}/costs`, query), opts);
}

/** Download link for `GET /api/v1/roboapply/admin/costs.csv` (an anchor `href`). */
export function costsCsvUrl(query?: In<typeof AD.CostsQuerySchema>): string {
  return apiUrl(withQuery(`${CONSOLE}/costs.csv`, query));
}

/** `admin.safety` — GET /api/v1/roboapply/admin/safety */
export function getSafety(query?: In<typeof AD.SafetyQuerySchema>, opts?: CallOptions): Promise<AD.SafetyResponse> {
  return call<AD.SafetyResponse>('GET', withQuery(`${CONSOLE}/safety`, query), opts);
}

/** `admin.reports` — GET /api/v1/roboapply/admin/reports */
export function listReports(query?: In<typeof AD.ReportsQuerySchema>, opts?: CallOptions): Promise<AD.ReportsResponse> {
  return call<AD.ReportsResponse>('GET', withQuery(`${CONSOLE}/reports`, query), opts);
}

/** `admin.resolveReport` — POST /api/v1/roboapply/admin/reports/:id/resolve */
export function resolveReport(id: string, body: In<typeof AD.ResolveReportBodySchema>, opts?: CallOptions): Promise<AD.ResolveReportResponse> {
  return call<AD.ResolveReportResponse>('POST', `${CONSOLE}/reports/${seg(id)}/resolve`, { ...opts, body });
}

/** `admin.overrides` — GET /api/v1/roboapply/admin/overrides */
export function listOverrides(query?: In<typeof AD.AdminOverridesQuerySchema>, opts?: CallOptions): Promise<AD.AdminOverridesResponse> {
  return call<AD.AdminOverridesResponse>('GET', withQuery(`${CONSOLE}/overrides`, query), opts);
}

/** `admin.createOverride` — POST /api/v1/roboapply/admin/overrides */
export function createOverride(body: In<typeof AD.AdminCreateOverrideBodySchema>, opts?: CallOptions): Promise<AD.AdminOverrideView> {
  return call<AD.AdminOverrideView>('POST', `${CONSOLE}/overrides`, { ...opts, body });
}

/** `admin.deleteOverride` — DELETE /api/v1/roboapply/admin/overrides/:id */
export function deleteOverride(id: string, query?: In<typeof AD.DeleteOverrideQuerySchema>, opts?: CallOptions): Promise<null> {
  return call<null>('DELETE', withQuery(`${CONSOLE}/overrides/${seg(id)}`, query), opts);
}

/** `admin.copilotFeedback` — GET /api/v1/roboapply/admin/copilot-feedback */
export function listCopilotFeedback(query?: In<typeof AD.CopilotFeedbackQuerySchema>, opts?: CallOptions): Promise<AD.AdminFeedbackResponse> {
  return call<AD.AdminFeedbackResponse>('GET', withQuery(`${CONSOLE}/copilot-feedback`, query), opts);
}

/** `cn.referrals.admin.queue` — GET /api/v1/roboapply/admin/cn/referrals/queue (WP-54) */
export function listReferralQueue(query?: In<typeof CR.ReferralQueueQuerySchema>, opts?: CallOptions): Promise<CR.ReferralQueueResponse> {
  return call<CR.ReferralQueueResponse>('GET', withQuery(`${CONSOLE}/cn/referrals/queue`, query), opts);
}

/**
 * `admin.moderateReferral` — POST /api/v1/roboapply/admin/referrals/:id/moderate.
 * Same body and rules as WP-54's /admin/cn/referrals/:id/moderate (both write
 * an audit row; the console uses this one).
 */
export function moderateReferralCode(id: string, body: In<typeof CR.ModerateReferralCodeBodySchema>, opts?: CallOptions): Promise<{ id: string; status: string }> {
  return call<{ id: string; status: string }>('POST', `${CONSOLE}/referrals/${seg(id)}/moderate`, { ...opts, body });
}

/** `credits.admin.refundQuote` — GET /api/v1/roboapply/admin/credits/refund-quote?userId (WP-21a) */
export function getRefundQuote(userId: string, opts?: CallOptions): Promise<RefundQuoteResponse> {
  return call<RefundQuoteResponse>('GET', withQuery(`${CONSOLE}/credits/refund-quote`, { userId }), opts);
}

export const adminConsoleApi = {
  getSystemStatus,
  listWorkItems,
  retryWorkItem,
  listAdminAudit,
  getCosts,
  costsCsvUrl,
  getSafety,
  listReports,
  resolveReport,
  listOverrides,
  createOverride,
  deleteOverride,
  listCopilotFeedback,
  listReferralQueue,
  moderateReferralCode,
  getRefundQuote,
};
