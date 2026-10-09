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

/** A same-site path or null (never an absolute or protocol-relative URL). */
export function safeNext(raw: string | null | undefined): string | null {
  return raw && /^\/(?![/\\])/.test(raw) && raw.length <= 512 ? raw : null;
}

export type AuthContextKind = 'apply' | 'job' | 'resume_check' | 'default';

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
