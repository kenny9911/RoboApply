import type { ExternalSearchParams } from '../roboapply/v2/lib/raExternalJobTypes.js';
import type { ProviderJob } from './normalization.js';

// Contract verified against https://hiringindex.org/docs, 2026-09-12.
// This optional provider is excluded from the default operator allowlist.
const HOST = 'hiringindex.p.rapidapi.com';
let daily = { day: '', used: 0 };
let blockedUntil = 0;

function budget(): number {
  const raw = Number(process.env.JOB_SEARCH_HIRINGINDEX_DAILY_BUDGET ?? '100');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100;
}

export function isHiringIndexEnabled(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== daily.day) daily = { day, used: 0 };
  return Boolean(process.env.RAPID_API_KEY?.trim()) && process.env.JOB_SEARCH_HIRINGINDEX_DISABLED !== 'true'
    && Date.now() >= blockedUntil && daily.used < budget();
}

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function date(value: unknown): string | null {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

export function normalizeHiringIndexJob(value: unknown, fetchedAt: string): ProviderJob | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw._id);
  const title = text(raw.title);
  const company = text(raw.company_name);
  if (!id || !title || !company) return null;
  const salary = raw.salary && typeof raw.salary === 'object' ? raw.salary as Record<string, unknown> : {};
  const employment = (text(raw.employment_type) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const employmentMap: Record<string, string> = { fulltime: 'full_time', parttime: 'part_time', contract: 'contract', contractor: 'contract', intern: 'internship', internship: 'internship' };
  const postedAt = date(raw.posted_at);
  return {
    externalId: `hiringindex:${id}`, sourceBoard: 'hiringindex', title, company,
    companyLogoUrl: null,
    location: [raw.city, raw.region, raw.country].map(text).filter((v, index, values) => v && values.indexOf(v) === index).join(', ') || null,
    locationCity: text(raw.city), locationCountry: text(raw.country_code) ?? text(raw.country),
    workType: raw.remote_flag === 'true' ? 'remote' : 'unknown',
    employmentType: employmentMap[employment] ?? null,
    salaryMin: number(salary.min), salaryMax: number(salary.max), salaryCurrency: text(salary.currency), salaryPeriod: text(salary.period),
    postedAt: postedAt ?? fetchedAt, postedAtEstimated: !postedAt,
    fetchedAt: date(raw.fetched_at) ?? fetchedAt,
    applyUrl: text(raw.apply_url) ?? text(raw.posting_url), sourceUrl: text(raw.posting_url),
    applyIsDirect: true, description: text(raw.description) ?? '', sourcePublisher: text(raw.source_platform),
  };
}

export async function searchHiringIndex(
  params: ExternalSearchParams,
  opts?: { requestId?: string; signal?: AbortSignal },
): Promise<ProviderJob[] | null> {
  if (!isHiringIndexEnabled() || opts?.signal?.aborted) return null;
  const title = (params.titleQuery ?? params.query).trim();
  if (title.length < 3) return null; // Provider's documented trigram minimum.
  const payload: Record<string, unknown> = {
    job_titles: [title], country_codes: [params.country.toUpperCase()], page: 1, limit: 20,
  };
  if (params.locationText) payload.cities = [params.locationText];
  if (params.workFromHome) payload.remote_flag = ['true'];
  const days = { today: 1, '3days': 3, week: 7, month: 30 };
  if (params.datePosted && params.datePosted !== 'all') payload.days_ago = days[params.datePosted];
  daily.used += 1;
  const signal = opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
  try {
    const response = await fetch(`https://${HOST}/jobs/search`, {
      method: 'POST', signal,
      headers: { 'x-rapidapi-host': HOST, 'x-rapidapi-key': process.env.RAPID_API_KEY!.trim(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // No automatic retry: every HTTP request is tracked; every returned posting
    // consumes provider result quota. Callers may retry after the cooldown.
    if ([401, 403].includes(response.status)) blockedUntil = Date.now() + 3_600_000;
    if ([429, 503].includes(response.status)) {
      const retry = Number(response.headers.get('retry-after') ?? '60');
      blockedUntil = Date.now() + Math.min(Math.max(Number.isFinite(retry) ? retry : 60, 1), 3600) * 1000;
    }
    if (!response.ok) return null;
    const body = await response.json() as { jobs?: unknown[] } | null;
    if (!body || !Array.isArray(body.jobs)) return null;
    const fetchedAt = new Date().toISOString();
    const jobs = body.jobs.slice(0, 100).map((job) => normalizeHiringIndexJob(job, fetchedAt)).filter((job): job is ProviderJob => job !== null);
    return body.jobs.length > 0 && jobs.length === 0 ? null : jobs;
  } catch { return null; }
}

export const __test = { reset() { daily = { day: '', used: 0 }; blockedUntil = 0; } };
