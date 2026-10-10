// components/features/visitor/model.ts — pure helpers for the visitor surfaces (WP-78).
// No React, no copy.

import type { AnonAlertFilters } from '../../../lib/api/contracts/visitor';

/** The visitor list never shows more than this before the signup gate (server twin: VISITOR_FEED_LIMIT). */
export const VISITOR_FEED_LIMIT = 20;

/** `/signup?from=<from>` (and `next` when given). */
export function signupHref(from: string, next?: string | null): string {
  const qs = new URLSearchParams({ from });
  if (next) qs.set('next', next);
  return `/signup?${qs.toString()}`;
}

/**
 * Where a job on a visitor surface opens: its public page when the brand has
 * them (the server sends `path`; `/job/<id>` 301s to the canonical slug), else
 * signup that then opens the job in the app.
 */
export function visitorJobHref(job: { jobId: string; path?: string | null }, market: 'intl' | 'cn', from: string): string {
  if (job.path) return job.path;
  if (market === 'intl') return `/job/${encodeURIComponent(job.jobId)}`;
  return signupHref(from, `/jobs/${job.jobId}`);
}

/** `/tools/job-alerts` prefilled with the page's search. */
export function alertsHref(query: { role?: string; city?: string; country?: string } = {}): string {
  const qs = new URLSearchParams();
  if (query.role?.trim()) qs.set('role', query.role.trim());
  if (query.city?.trim()) qs.set('city', query.city.trim());
  if (query.country && /^[A-Z]{2}$/.test(query.country)) qs.set('country', query.country);
  const s = qs.toString();
  return s ? `/tools/job-alerts?${s}` : '/tools/job-alerts';
}

export interface AlertFormValues {
  email: string;
  role: string;
  city: string;
  /** ISO-3166 alpha-2 or ''. */
  country: string;
  remoteOnly: boolean;
  frequency: 'daily' | 'weekly';
  consent: boolean;
}

/** The form → the contract's filter subset (FilterSet v1 subset; empty fields are omitted). */
export function alertFilters(v: Pick<AlertFormValues, 'role' | 'city' | 'country' | 'remoteOnly'>): AnonAlertFilters {
  const out: AnonAlertFilters = {};
  const q = v.role.trim().slice(0, 120);
  if (q) out.q = q;
  const country = /^[A-Z]{2}$/.test(v.country) ? v.country : '';
  const city = v.city.trim().slice(0, 80);
  if (city) out.locations = [{ label: city, city, ...(country ? { country } : {}) }];
  else if (country) out.country = country;
  if (v.remoteOnly) out.workModels = ['remote'];
  return out;
}

/** Light check before the server's: one @, a dot in the domain, no spaces. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}

/** "Data analyst · Taipei" from saved filters; '' when nothing narrows them. */
export function filtersLabel(f: AnonAlertFilters, regionName: (code: string) => string = (c) => c): string {
  const parts: string[] = [];
  if (f.q?.trim()) parts.push(f.q.trim());
  if (f.locations?.length) parts.push(...f.locations.map((l) => l.label).filter(Boolean));
  else if (f.country) parts.push(regionName(f.country));
  return parts.join(' · ');
}

/** Countries offered in the alert form, per market (the visitor can also leave it at "Any"). */
export const ALERT_COUNTRIES: Record<'intl' | 'cn', readonly string[]> = {
  intl: ['US', 'CA', 'GB', 'IE', 'DE', 'FR', 'NL', 'ES', 'PT', 'TW', 'HK', 'SG', 'JP', 'KR', 'AU', 'NZ', 'IN'],
  cn: ['CN'],
};

/** A region name in the UI language (falls back to the code). */
export function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
