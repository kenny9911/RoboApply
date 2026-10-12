// server/src/interview-engine/prep/webSearch.ts
//
// The prep agents' web leg, through Tavily (the one search vendor the
// platform uses). Two uses:
//   - searchWebPostings: job postings on employers' own career sites and
//     public ATS boards, for a role the job index and the job boards did not
//     cover (a niche title, a market without a licensed feed);
//   - searchWeb: plain results for research (a company's interview process).
//
// Rules this file keeps:
//   - Queries carry a job title and a company name only; assertNoPiInPayload
//     refuses a query with personal information, and refuses the vendor
//     entirely where the brand's residency rule forbids it.
//   - Sites whose terms forbid machine reading (IMPORT_FETCH_DENYLIST) are
//     excluded from the request and dropped from the answer: their content is
//     never used, and their links are never listed as postings.
//   - Never throws: a missing key, a refusal or a failure answers null.

import { createHash } from 'node:crypto';
import { assertNoPiInPayload } from '../../platform/residency/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { DEFAULT_IMPORT_FETCH_DENYLIST } from '../../features/jobs/import/contract.js';
import { isDeniedHost } from '../../features/jobs/import/urlPolicy.js';
import { clip, clipBlock, type PrepPosting } from './contract.js';

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface WebSearchDeps {
  env?: EnvSource;
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WebResult {
  title: string;
  url: string;
  host: string;
  content: string;
  publishedAt: string | null;
}

/** Public ATS boards and career-site hosts whose postings are open to read. */
export const ATS_POSTING_DOMAINS = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'smartrecruiters.com',
  'workable.com',
  'recruitee.com',
  'teamtailor.com',
  'personio.de',
  'jobvite.com',
  'icims.com',
  'bamboohr.com',
  'breezy.hr',
  'jobs.ashbyhq.com',
];

/** Exact domains for Tavily's exclude list (wildcard entries spelled out for their common hosts). */
function excludedDomains(): string[] {
  const out: string[] = [];
  for (const pattern of DEFAULT_IMPORT_FETCH_DENYLIST) {
    if (pattern.endsWith('.*')) {
      const name = pattern.slice(0, -2);
      out.push(`${name}.com`, `${name}.co.uk`, `${name}.de`, `${name}.fr`, `${name}.co.jp`);
    } else {
      out.push(pattern);
    }
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function tavilyConfigured(env: EnvSource = process.env): boolean {
  return !!env.TAVILY_API_KEY?.trim();
}

/** Pure: Tavily results → web results (drops unusable rows and denied hosts). */
export function toWebResults(results: unknown, env: EnvSource = process.env): WebResult[] {
  if (!Array.isArray(results)) return [];
  const out: WebResult[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    const host = url ? hostOf(url) : null;
    const title = clip(row.title, 200);
    if (!url || !host || !title) continue;
    if (isDeniedHost(host, env)) continue;
    out.push({
      title,
      url,
      host,
      content: clipBlock(row.content, 1600),
      publishedAt: typeof row.published_date === 'string' && row.published_date.trim() ? row.published_date.trim() : null,
    });
  }
  return out;
}

/**
 * One Tavily search. Null when the vendor is unavailable for this brand, the
 * key is missing, the query carries personal information, or the call fails.
 */
export async function searchWeb(
  brand: ProductBrand,
  query: string,
  options: { maxResults?: number; includeDomains?: string[]; depth?: 'basic' | 'advanced'; knownValues?: ReadonlyArray<string | null | undefined> } = {},
  deps: WebSearchDeps = {},
): Promise<WebResult[] | null> {
  const env = deps.env ?? process.env;
  const key = env.TAVILY_API_KEY?.trim();
  const q = clip(query, 380);
  if (!key || !q) return null;
  try {
    assertNoPiInPayload({ brand, target: TAVILY_SEARCH_URL, payload: q, env, knownValues: options.knownValues });
  } catch {
    return null;
  }
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 9000);
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await doFetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: q,
        max_results: Math.min(10, Math.max(1, options.maxResults ?? 6)),
        search_depth: options.depth ?? 'basic',
        include_answer: false,
        include_raw_content: false,
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
        exclude_domains: excludedDomains(),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: unknown };
    return toWebResults(data?.results, env);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

/** A path or query that names a single posting (career sites and ATS boards, CJK sites included). */
const JOB_PATH = /(job|position|vacanc|opening|posting|recruit|zhaopin|career|gh_jid|apply)/i;
/** Host names of employers' own career sites (careers.example.com, jobs.example.cn, talent.…). */
const JOB_HOST = /^(careers?|jobs?|join|talent|hr|zhaopin|recruit(ment)?|apply|campus)\./i;

/** True when a result looks like a posting page, not a blog or a list of tips. */
export function looksLikePosting(url: string, host: string): boolean {
  if (ATS_POSTING_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  if (JOB_HOST.test(host)) return true;
  try {
    const u = new URL(url);
    if (/\/(blog|news|article|guide|tips|advice)s?\//i.test(u.pathname)) return false;
    return JOB_PATH.test(`${u.pathname}${u.search}`);
  } catch {
    return false;
  }
}

/** "Senior Engineer - Acme" / "Acme | Senior Engineer" / "Job Application for X at Acme" → title and company. */
export function splitPostingTitle(raw: string, host: string): { title: string; company: string | null } {
  const text = raw.replace(/\s+/g, ' ').trim();
  const at = text.match(/^(?:job application for\s+)?(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (at) return { title: at[1].trim(), company: at[2].trim() };
  const parts = text.split(/\s+[-|–—]\s+/);
  if (parts.length >= 2) {
    const [first, second] = parts;
    // A part that names the host's own brand is the company.
    const hostWord = host.split('.').find((part) => part.length > 3 && !['jobs', 'careers', 'boards', 'apply'].includes(part)) ?? '';
    if (hostWord && second.toLowerCase().includes(hostWord)) return { title: first, company: second };
    if (hostWord && first.toLowerCase().includes(hostWord)) return { title: second, company: first };
    return { title: first, company: second };
  }
  return { title: text, company: null };
}

/** The company of an ATS board link (boards.greenhouse.io/acme/jobs/1 → "acme"), or null. */
function companyFromAtsUrl(url: string, host: string): string | null {
  if (!ATS_POSTING_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return null;
  try {
    const u = new URL(url);
    const sub = host.split('.')[0];
    if (sub && !['boards', 'jobs', 'apply', 'careers', 'www', 'job-boards'].includes(sub) && host.split('.').length > 2) return sub;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg && seg.length > 1 ? decodeURIComponent(seg).replace(/[-_]+/g, ' ') : null;
  } catch {
    return null;
  }
}

/**
 * Job postings on open career sites for a title (and optionally a company).
 * Results are labelled with their host; nothing here claims a posting is
 * still open (the page itself says so when the candidate opens it).
 */
export async function searchWebPostings(
  brand: ProductBrand,
  input: { title: string; company?: string | null; country?: string | null; language?: string | null },
  deps: WebSearchDeps = {},
): Promise<PrepPosting[] | null> {
  const title = clip(input.title, 100);
  if (!title) return null;
  const company = clip(input.company, 80);
  const chinese = (input.language ?? '').startsWith('zh') || brand.market === 'cn';
  const query = chinese
    ? `${company ? `${company} ` : ''}${title} 招聘 岗位职责 任职要求`
    : `${company ? `${company} ` : ''}"${title}" job opening responsibilities qualifications${input.country ? ` ${input.country}` : ''}`;
  const results = await searchWeb(
    brand,
    query,
    { maxResults: 8, includeDomains: chinese || company ? undefined : ATS_POSTING_DOMAINS, depth: 'basic' },
    deps,
  );
  if (!results) return null;
  const out: PrepPosting[] = [];
  for (const result of results) {
    if (!looksLikePosting(result.url, result.host)) continue;
    const split = splitPostingTitle(result.title, result.host);
    const ref = `web:${createHash('sha256').update(result.url).digest('hex').slice(0, 16)}`;
    out.push({
      ref,
      source: 'web',
      provider: result.host,
      jobId: null,
      title: clip(split.title, 160),
      company: clip(split.company ?? companyFromAtsUrl(result.url, result.host) ?? '', 120) || null,
      location: null,
      postedAt: result.publishedAt,
      url: result.url,
      snippet: clip(result.content, 280) || null,
      description: clipBlock(result.content, 1600) || null,
    });
  }
  return out;
}

/** Numbered results for a research prompt: "[1] title — url\ncontent". */
export function formatResults(results: readonly WebResult[], maxChars = 6000): string {
  const blocks: string[] = [];
  let total = 0;
  results.forEach((result, index) => {
    const block = `[${index + 1}] ${result.title} — ${result.url}\n${result.content}`;
    if (total + block.length > maxChars) return;
    blocks.push(block);
    total += block.length;
  });
  return blocks.join('\n\n');
}
