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
  mrrUsd: number;
  monthlyCostRunRateUsd: number;
  grossMarginUsd: number;
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
  revenueRunRateUsd: number;
}

export interface AdminMrrByTierEntry {
  count: number;
  mrrUsd: number;
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
  mrrUsd: number;
  periodCostUsd: number;
  marginUsd: number;
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
  mrrUsd: number;
  amountMinor: number | null;
  currency: string;
  dailyCap: number | null;
  stripeCustomerId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface AdminUserDetailProfitability {
  lifetimeCostUsd: number;
  periodCostUsd: number;
  mrrUsd: number;
  marginUsd: number;
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
