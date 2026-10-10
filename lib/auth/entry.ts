// lib/auth/entry.ts — entry attribution and contextual copy for login/signup
// (F-ONB-02; PRODUCT_PLAN.md O0 rows 1 and 10).
//
// The query parameters a visitor arrives with (`from`, `job`, `action=apply`,
// `ref`, `utm_*`, `alert`, `next`) are carried between /login and /signup
// unchanged, sent with the signup once (SeekerProfile.onboardingEntry +
// growth attribution), and decide the contextual title.
//
// The URL never supplies display text: a job title or company shown on the
// page comes from looking the `job` id up (useEntryJob), so a crafted link
// cannot put arbitrary words on a brand page, and nothing unverified is shown.

import type { SignupAttribution } from '../api/auth';
import { getAttribution } from '../analytics';

/** Query keys carried between the auth pages. */
export const CARRIED_PARAMS = ['next', 'from', 'job', 'action', 'ref', 'utm_source', 'utm_medium', 'utm_campaign', 'alert'] as const;

type Params = { get(name: string): string | null } | null | undefined;

const clip = (v: string | null | undefined, max: number) => {
  const s = (v ?? '').trim();
  return s ? s.slice(0, max) : undefined;
};

export function attributionFrom(params: Params, landingPath?: string): SignupAttribution | undefined {
  if (!params) return undefined;
  const a: SignupAttribution = {
    from: clip(params.get('from'), 80),
    jobId: clip(params.get('job'), 64),
    action: params.get('action') === 'apply' ? 'apply' : undefined,
    ref: clip(params.get('ref'), 64),
    utmSource: clip(params.get('utm_source'), 120),
    utmMedium: clip(params.get('utm_medium'), 120),
    utmCampaign: clip(params.get('utm_campaign'), 120),
    alert: clip(params.get('alert'), 200),
    landingPath: clip(landingPath, 512),
  };
  const filled = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as SignupAttribution;
  return Object.keys(filled).length ? filled : undefined;
}

/** `?a=b&…` with only the carried keys (to link /login ⇄ /signup without losing context). */
export function carriedQuery(params: Params): string {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const v = params.get(key);
    if (v) q.set(key, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * What signup sends as `attribution`: this page's entry parameters (they
 * become `SeekerProfile.onboardingEntry`) plus the visitor's stored first and
 * last touch (lib/analytics `getAttribution()`), which the server reads with
 * growth `touchesFromClient`. Where analytics linking is not allowed the
 * stored touches carry only the referral and the job (getAttribution trims
 * them), and the server drops marketing fields again.
 */
export function signupAttribution(params: Params, landingPath?: string): SignupAttribution | undefined {
  const entry = attributionFrom(params, landingPath);
  let stored: ReturnType<typeof getAttribution> = null;
  try {
    stored = getAttribution();
  } catch {
    stored = null;
  }
  if (!stored) return entry;
  return { ...(entry ?? {}), firstTouch: stored.firstTouch, ...(stored.lastTouch ? { lastTouch: stored.lastTouch } : {}) };
}

/** A same-site path or null (never an absolute or protocol-relative URL). */
export function safeNext(raw: string | null | undefined): string | null {
  return raw && /^\/(?![/\\])/.test(raw) && raw.length <= 512 ? raw : null;
}

/**
 * `next` paths honoured right after sign-in or sign-up even while onboarding
 * is unfinished: the public free-tool pages, where a signed-out visitor asked
 * to keep a result and create an account (WP-57). Any other `next` waits
 * until onboarding is done. Server twin: `PRIORITY_NEXT_PATHS` in
 * server/src/features/auth/contract.ts (lib/auth/auth.test.ts keeps them equal).
 */
export const PRIORITY_NEXT_PATHS = ['/tools/resume-check', '/tools/resume-job-match'] as const;

/** The path when `raw` is a same-site path on the PRIORITY_NEXT_PATHS list (query and hash kept), else null. */
export function priorityNext(raw: string | null | undefined): string | null {
  const next = safeNext(raw);
  if (!next) return null;
  const path = next.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return (PRIORITY_NEXT_PATHS as readonly string[]).includes(path) ? next : null;
}

export type AuthContextKind = 'apply' | 'job' | 'resume_check' | 'resume_job_match' | 'default';

/**
 * Which contextual title/brand-panel variant applies, and the job id to look
 * up. A job variant renders only once that lookup returns the job; until
 * then (or when it fails) the default copy is shown.
 */
export function entryContext(params: Params): { kind: AuthContextKind; jobId: string | null } {
  const jobId = clip(params?.get('job'), 64) ?? null;
  if (params?.get('action') === 'apply' && jobId) return { kind: 'apply', jobId };
  if (jobId) return { kind: 'job', jobId };
  if (params?.get('from') === 'resume-check') return { kind: 'resume_check', jobId: null };
  if (params?.get('from') === 'resume-job-match') return { kind: 'resume_job_match', jobId: null };
  return { kind: 'default', jobId: null };
}

/** The browser's IANA time zone, when it reports one. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
