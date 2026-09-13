import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { ExternalJobNormalized } from '../roboapply/v2/lib/raExternalJobTypes.js';
import type { EmploymentType, SearchInput, SearchJob } from './types.js';
import { countryCode, EMPLOYMENT_TYPES } from './validation.js';

export type ProviderJob = Omit<ExternalJobNormalized, 'sourceBoard'> & { sourceBoard: string; sourceUrl?: string | null };

/** Validate links for navigation only. Never fetch URLs supplied by a job record. */
export function safeJobUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const ip = host.replace(/^\[|\]$/g, '');
    // Employer links are public DNS names. Reject local names and IP literals,
    // including alternative encodings normalized by WHATWG URL.
    if (isIP(ip) || !host.includes('.') || /\.(localhost|local|internal|test|invalid)$/.test(host)) return null;
    if (url.port && url.port !== '443' && url.port !== '80') return null;
    return url.toString();
  } catch { return null; }
}

export function canonicalApplyUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|referrer|ref|source|trackingId|trk)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  // Keep requisition IDs and path case intact; only remove terminal slash.
  return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

function clean(raw: unknown, max = 500): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';
}

function iso(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeJob(raw: ProviderJob, fetchedAt: string): SearchJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const applyUrl = safeJobUrl(raw.applyUrl);
  const title = clean(raw.title);
  const company = clean(raw.company);
  if (!applyUrl || !title || !company) return null;
  const id = `job_${createHash('sha256').update(canonicalApplyUrl(applyUrl)).digest('hex').slice(0, 24)}`;
  const min = amount(raw.salaryMin);
  const max = amount(raw.salaryMax);
  const currency = clean(raw.salaryCurrency).toUpperCase();
  const period = clean(raw.salaryPeriod).toLowerCase().replace(/^(1\s+)/, '');
  const periodMap: Record<string, string> = { yearly: 'year', annually: 'year', annual: 'year', monthly: 'month', weekly: 'week', daily: 'day', hourly: 'hour' };
  const normalizedPeriod = periodMap[period] ?? period;
  return {
    id, title, company,
    companyLogoUrl: safeJobUrl(raw.companyLogoUrl),
    location: clean(raw.location) || null,
    country: raw.locationCountryEstimated ? null : countryCode(raw.locationCountry),
    // Returned as inert text. Browser consumers must not render source HTML.
    description: clean(raw.description, 20_000).replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' '),
    applyUrl,
    sourceUrl: safeJobUrl(raw.sourceUrl) ?? applyUrl,
    applyIsDirect: raw.applyIsDirect === true,
    provider: raw.sourceBoard,
    sources: [{ provider: raw.sourceBoard, id: clean(raw.externalId, 300), applyUrl, publisher: clean(raw.sourcePublisher) || null, sourceUrl: safeJobUrl(raw.sourceUrl) ?? applyUrl }],
    postedAt: raw.postedAtEstimated ? null : iso(raw.postedAt),
    fetchedAt: iso(raw.fetchedAt) ?? fetchedAt,
    remote: raw.workType === 'remote' ? true : null,
    employmentType: EMPLOYMENT_TYPES.includes(raw.employmentType as EmploymentType) ? raw.employmentType as EmploymentType : null,
    salary: min !== null || max !== null ? {
      min: min !== null && max !== null && min > max ? null : min,
      max: min !== null && max !== null && min > max ? null : max,
      currency: !raw.salaryCurrencyInferred && /^[A-Z]{3}$/.test(currency) ? currency : null,
      period: ['year', 'month', 'week', 'day', 'hour'].includes(normalizedPeriod) ? normalizedPeriod : null,
    } : null,
  };
}

const DAYS = { today: 1, '3days': 3, week: 7, month: 30 } as const;

/** Requested fact filters are strict: unknown facts do not establish a match. */
export function matchesFilters(job: SearchJob, input: SearchInput, now: number): boolean {
  if (job.country && job.country.toLowerCase() !== input.country) return false;
  if (input.remote && job.remote !== true) return false;
  if (input.employmentTypes?.length && (!job.employmentType || !input.employmentTypes.includes(job.employmentType))) return false;
  if (input.datePosted && input.datePosted !== 'all') {
    if (!job.postedAt) return false;
    const posted = Date.parse(job.postedAt);
    if (posted < now - DAYS[input.datePosted] * 86_400_000 || posted > now + 86_400_000) return false;
  }
  return true;
}

function fingerprint(job: SearchJob): string | null {
  if (!job.location) return null;
  const token = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return [job.company, job.title, job.location, job.country ?? ''].map(token).join('|');
}

function distinctRequisitions(a: SearchJob, b: SearchJob): boolean {
  return a.sources.some(source => b.sources.some(other =>
    source.provider === other.provider && source.id !== other.id));
}

/** Caller supplies preferred source order; an explicit direct apply link wins. */
export function deduplicateJobs(jobs: SearchJob[]): { jobs: SearchJob[]; deduplicated: number } {
  const rows: SearchJob[] = [];
  const byUrl = new Map<string, SearchJob>();
  // null marks an ambiguous title/company/location shared by distinct roles.
  const byFingerprint = new Map<string, SearchJob | null>();
  let deduplicated = 0;
  for (const candidate of jobs) {
    const url = canonicalApplyUrl(candidate.applyUrl);
    const key = fingerprint(candidate);
    const urlMatch = byUrl.get(url);
    const possibleMatch = key ? byFingerprint.get(key) : undefined;
    const conflictingIds = possibleMatch && (distinctRequisitions(possibleMatch, candidate) ||
      (urlMatch && urlMatch !== possibleMatch && distinctRequisitions(urlMatch, possibleMatch)));
    const fingerprintMatch = conflictingIds ? undefined : possibleMatch;
    if (conflictingIds && key) byFingerprint.set(key, null);
    const existing = urlMatch ?? fingerprintMatch;
    if (!existing) {
      rows.push(candidate);
      byUrl.set(url, candidate);
      if (key) byFingerprint.set(key, byFingerprint.has(key) ? null : candidate);
      continue;
    }
    deduplicated += 1;
    // A posting can bridge two previously separate groups (same URL as one,
    // same title/location as another). Merge the groups and all their aliases.
    if (urlMatch && fingerprintMatch && urlMatch !== fingerprintMatch) {
      for (const source of fingerprintMatch.sources) {
        if (!existing.sources.some((s) => s.provider === source.provider && s.id === source.id)) existing.sources.push(source);
      }
      if (fingerprintMatch.applyIsDirect && !existing.applyIsDirect) {
        const combinedSources = existing.sources;
        Object.assign(existing, fingerprintMatch);
        existing.sources = combinedSources;
      }
      rows.splice(rows.indexOf(fingerprintMatch), 1);
      for (const [alias, entry] of byUrl) if (entry === fingerprintMatch) byUrl.set(alias, existing);
      for (const [alias, entry] of byFingerprint) if (entry === fingerprintMatch) byFingerprint.set(alias, existing);
      deduplicated += 1;
    }
    const sources = [...existing.sources];
    for (const source of candidate.sources) if (!sources.some((s) => s.provider === source.provider && s.id === source.id)) sources.push(source);
    if (candidate.applyIsDirect && !existing.applyIsDirect) Object.assign(existing, candidate);
    existing.sources = sources;
    byUrl.set(url, existing);
    if (key && byFingerprint.get(key) !== null) byFingerprint.set(key, existing);
  }
  return { jobs: rows, deduplicated };
}
