// roboapply-app/lib/api/auth.ts
//
// Typed wrappers around the auth surface (WP-10). Legacy paths
// `/api/v1/roboapply/auth/{signup,login,me,logout}` live in
// server/src/roboapply/routes/auth.ts; the new paths (methods, password
// reset, email verification, Google/LINE, identities, consents, sessions)
// live in server/src/features/auth/routes.ts. Wire types come from the
// server contract (lib/api/contracts/auth.ts).

import { roboApi } from './client';
import type {
  AuthMeAdditions,
  AuthMethodsResponse,
  ConsentsResponse,
  ConsentView,
  EmailStatusResponse,
  IdentitiesResponse,
  OAuthCallbackResult,
  SessionsResponse,
  VerifyEmailResult,
} from './contracts/auth';
import type { PublicJobCard } from './contracts/seo';
import type { Touch } from './contracts/growth';

export type {
  AuthMeAdditions,
  AuthMethodsResponse,
  AuthMethodView,
  ConsentView,
  EmailStatusResponse,
  IdentityView,
  OAuthCallbackResult,
  SessionView,
  VerifyEmailResult,
} from './contracts/auth';

const AUTH = '/api/v1/roboapply/auth';
const ACCOUNT = '/api/v1/roboapply/account';

export interface RoboUserSummary {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  roles: string[];
}

export type OnboardingStep =
  | 'resume'
  | 'preferences'
  | 'interview'
  | 'profile_video'
  | 'complete';

export interface MeResponse extends Partial<AuthMeAdditions> {
  user: RoboUserSummary;
  profile: Record<string, unknown> | null;
  // Legacy signal for the old setup panel on /jobs (until WP-30 replaces it):
  //   completedSteps → WHICH step opens; skippedAt → suppress auto-open for 7
  //   days (except no-resume); autoOpens → the hard cap (two).
  onboardingState?: {
    completed: boolean;
    step?: OnboardingStep;
    completedSteps?: OnboardingStep[];
    /** ISO timestamp, or null when the user never skipped. */
    skippedAt?: string | null;
    autoOpens?: number;
  };
}

export interface AuthSessionResponse {
  user: RoboUserSummary;
  token: string;
}

export interface ConsentInput {
  type: string;
  granted: boolean;
  proseVersion: string;
  /**
   * GoApply email sign-up: the hash of the consent text shown beside the box
   * (`prose.hash` from the sign-up policy). The server stores a consent
   * record only for a text it serves, so the record names what was on screen.
   */
  proseHash?: string;
}

export interface SignupAttribution {
  from?: string;
  jobId?: string;
  action?: 'apply';
  ref?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  alert?: string;
  landingPath?: string;
  /**
   * The visitor's stored touches (lib/analytics `getAttribution()`); the
   * server reads them with growth `touchesFromClient`. The fields above are
   * this page's own entry parameters.
   */
  firstTouch?: Touch;
  lastTouch?: Touch | null;
}

export interface SignupPayload {
  email: string;
  password: string;
  name?: string;
  locale?: string;
  /** Required: `age_16_plus`; plus `tw_pdpa_notice` for zh-TW / Taiwan. */
  consents?: ConsentInput[];
  /** "Send me product news and tips" — unchecked by default. */
  marketingOptIn?: boolean;
  attribution?: SignupAttribution;
  timezone?: string;
  /** GoApply: the invite code, required while sign-up is invite-only. */
  inviteCode?: string;
}

/** 201: the account exists and the session cookie is set. 200: the normal "check your email" answer. */
export type SignupResult =
  | (AuthSessionResponse & { next?: string; status?: undefined })
  | { status: 'check_email' };

export interface LoginPayload {
  email: string;
  password: string;
}

export function signup(body: SignupPayload) {
  return roboApi.post<SignupResult>(`${AUTH}/signup`, body);
}

export function login(body: LoginPayload) {
  return roboApi.post<AuthSessionResponse>(`${AUTH}/login`, body);
}

export function logout() {
  return roboApi.post<{ success: true }>(`${AUTH}/logout`);
}

export function getSession() {
  return roboApi.get<MeResponse>(`${AUTH}/me`);
}

// ── Methods ─────────────────────────────────────────────────────────────

export function getAuthMethods(locale?: string) {
  const qs = locale ? `?locale=${encodeURIComponent(locale)}` : '';
  return roboApi.get<AuthMethodsResponse>(`${AUTH}/methods${qs}`);
}

// ── Password reset ──────────────────────────────────────────────────────

export function requestPasswordReset(email: string) {
  return roboApi.post<null>(`${AUTH}/password/forgot`, { email });
}

export function resetPassword(token: string, password: string) {
  return roboApi.post<{ next: string }>(`${AUTH}/password/reset`, { token, password });
}

// ── Email verification ──────────────────────────────────────────────────

export function getEmailStatus() {
  return roboApi.get<EmailStatusResponse>(`${AUTH}/email/status`);
}

export function sendVerificationEmail() {
  return roboApi.post<null>(`${AUTH}/email/verify/send`);
}

export function verifyEmail(token: string) {
  return roboApi.get<VerifyEmailResult>(`${AUTH}/email/verify?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  });
}

// ── Google / LINE ───────────────────────────────────────────────────────

export type OAuthProvider = 'google' | 'line';

export interface OAuthStartParams {
  next?: string | null;
  /** Signup page: the visitor already ticked these boxes. */
  age?: boolean;
  pdpa?: boolean;
  marketing?: boolean;
  locale?: string;
  tz?: string;
  attribution?: SignupAttribution;
}

/** Longest `ft` / `lt` value the server reads (server twin: OAUTH_TOUCH_PARAM_MAX, features/auth/contract.ts). */
export const OAUTH_TOUCH_PARAM_MAX = 1500;

/** A stored touch as compact JSON for the start URL; without its landing page when too long, else left out. */
function touchParam(touch: Touch | null | undefined): string | null {
  if (!touch || typeof touch !== 'object') return null;
  const full = JSON.stringify(touch);
  if (full.length <= OAUTH_TOUCH_PARAM_MAX) return full;
  const { landingPath: _landingPath, ...rest } = touch;
  const short = JSON.stringify(rest);
  return short.length <= OAUTH_TOUCH_PARAM_MAX ? short : null;
}

/** The browser navigates here (a full-page redirect to the provider). */
export function oauthStartUrl(provider: OAuthProvider, params: OAuthStartParams = {}): string {
  const q = new URLSearchParams();
  if (params.next && /^\/(?![/\\])/.test(params.next)) q.set('next', params.next);
  if (params.age) q.set('age', '1');
  if (params.pdpa) q.set('pdpa', '1');
  if (params.age) q.set('marketing', params.marketing ? '1' : '0');
  if (params.locale) q.set('locale', params.locale);
  if (params.tz) q.set('tz', params.tz);
  const a = params.attribution;
  if (a?.from) q.set('from', a.from);
  if (a?.jobId) q.set('job', a.jobId);
  if (a?.action) q.set('action', a.action);
  if (a?.ref) q.set('ref', a.ref);
  if (a?.utmSource) q.set('utm_source', a.utmSource);
  if (a?.utmMedium) q.set('utm_medium', a.utmMedium);
  if (a?.utmCampaign) q.set('utm_campaign', a.utmCampaign);
  if (a?.alert) q.set('alert', a.alert);
  // The stored touches ride along too: the provider callback is a GET with no
  // body, so this is the only way a Google / LINE sign-up keeps them.
  const ft = touchParam(a?.firstTouch);
  const lt = touchParam(a?.lastTouch);
  if (ft) q.set('ft', ft);
  if (lt) q.set('lt', lt);
  const qs = q.toString();
  return `${AUTH}/oauth/${provider}/start${qs ? `?${qs}` : ''}`;
}

/** The web callback page forwards the provider's query here (JSON form). */
export function finishOAuth(provider: OAuthProvider, query: { code?: string | null; state?: string | null; error?: string | null }) {
  const q = new URLSearchParams();
  if (query.code) q.set('code', query.code);
  if (query.state) q.set('state', query.state);
  if (query.error) q.set('error', query.error);
  return roboApi.get<OAuthCallbackResult>(`${AUTH}/oauth/${provider}/callback?${q.toString()}`, {
    headers: { accept: 'application/json' },
  });
}

export interface OAuthAgreements {
  consents: ConsentInput[];
  marketingOptIn: boolean;
  locale?: string;
  timezone?: string;
}

export function completeOAuth(pendingToken: string, agreements: OAuthAgreements) {
  return roboApi.post<OAuthCallbackResult>(`${AUTH}/oauth/complete`, { pendingToken, ...agreements });
}

/** The provider shared no confirmed email (Google or LINE): verify one before the account exists. */
export function submitOAuthEmail(pendingToken: string, email: string, agreements: OAuthAgreements) {
  return roboApi.post<{ status: 'check_email' }>(`${AUTH}/oauth/email`, { pendingToken, email, ...agreements });
}

// ── Entry context ───────────────────────────────────────────────────────

/** The job a visitor came from, as the public job read reports it. */
export interface EntryJob {
  title: string;
  companyName: string | null;
}

function entryJobFrom(raw: unknown): EntryJob | null {
  const card = (raw && typeof raw === 'object' && 'job' in raw ? (raw as { job: unknown }).job : raw) as Partial<PublicJobCard> | null;
  const title = typeof card?.title === 'string' ? card.title.trim() : '';
  if (!title) return null;
  const company = typeof card?.companyName === 'string' ? card.companyName.trim() : '';
  return { title: title.slice(0, 160), companyName: company ? company.slice(0, 120) : null };
}

/**
 * The title and company of the job in a signup/login link (`job=<id>`), from
 * the public job read (WP-56: publicDisplay jobs only). Null when the job is
 * unknown, not public, or the read is unavailable; the page then shows its
 * default title. Never throws.
 */
export async function getEntryJob(jobId: string): Promise<EntryJob | null> {
  try {
    return entryJobFrom(await roboApi.get<unknown>(`/api/v1/public/seo/jobs/${encodeURIComponent(jobId)}`));
  } catch {
    return null;
  }
}

// ── Account: sign-in methods, consents, sessions ────────────────────────

export function listIdentities() {
  return roboApi.get<IdentitiesResponse>(`${ACCOUNT}/identities`);
}

export function unlinkIdentity(id: string) {
  return roboApi.delete<IdentitiesResponse>(`${ACCOUNT}/identities/${encodeURIComponent(id)}`);
}

export function listConsents() {
  return roboApi.get<ConsentsResponse>(`${ACCOUNT}/consents`);
}

export function recordConsent(input: ConsentInput) {
  return roboApi.post<ConsentView>(`${ACCOUNT}/consents`, input);
}

export function listSessions() {
  return roboApi.get<SessionsResponse>(`${ACCOUNT}/sessions`);
}

export function revokeSession(id: string) {
  return roboApi.delete<{ revoked: number }>(`${ACCOUNT}/sessions/${encodeURIComponent(id)}`);
}
