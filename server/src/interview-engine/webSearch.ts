// backend/src/interview-engine/webSearch.ts
//
// Self-contained Tavily client for the Interview Engine's prompt pipeline
// (requirement #4: "search the internet for job requirements first"). A small
// fork of roboapply/v2/lib/raWebSearch.ts so the engine stays standalone.
//
// Contract: NEVER throws. Returns null when TAVILY_API_KEY is missing or the
// request fails, so prompt generation degrades gracefully to role-title-only
// synthesis.
//
// Both brands (D5; GOAPPLY_PARITY_PLAN §3.5, G9): the search is a no-PI vendor
// for RoboApply and GoApply alike. `assertNoPiInPayload` checks the query
// before every search: it must not carry an email, a phone number, a
// government id or a value that identifies the user (their name), and the
// residency policy must allow the host for the brand (it does not on a
// mainland deployment, where the vendor is not used). A query that fails the
// check is not sent; preparation continues without web evidence.

import { logger } from '../services/LoggerService.js';
import { getBrand, type BrandId, type ProductBrand } from '../platform/brand/registry.js';
import { getCurrentBrandOrDefault } from '../platform/brand/brandContext.js';
import { assertNoPiInPayload } from '../platform/residency/egressPolicy.js';

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface InterviewWebResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface InterviewWebResponse {
  query: string;
  answer?: string;
  results: InterviewWebResult[];
}

export function isWebSearchEnabled(): boolean {
  return !!process.env.TAVILY_API_KEY?.trim();
}

export interface SearchJobRequirementsOptions {
  maxResults?: number;
  searchDepth?: 'basic' | 'advanced';
  /** Restrict the search to these job-board domains (e.g. linkedin.com/jobs). */
  includeDomains?: string[];
  requestId?: string;
  signal?: AbortSignal;
  /**
   * The brand the search runs for; default: the brand of the current unit of
   * work (session work always runs inside the session's brand).
   */
  brand?: BrandId | ProductBrand;
  /** Strings that identify the user (their name); a query containing one is never sent. */
  knownValues?: ReadonlyArray<string | null | undefined>;
}

function resolveBrand(brand: BrandId | ProductBrand | undefined): ProductBrand {
  if (brand && typeof brand === 'object') return brand;
  return brand ? getBrand(brand) : getCurrentBrandOrDefault();
}

/**
 * May this brand use the web search at all? Both brands may, unless the
 * residency policy refuses the vendor for the brand (a mainland deployment).
 * Whether a given query is sent is still decided per query (no personal
 * information), in `searchJobRequirements`.
 */
export function webSearchAllowedFor(brand?: BrandId | ProductBrand): boolean {
  try {
    assertNoPiInPayload({ brand: resolveBrand(brand), target: TAVILY_SEARCH_URL, payload: '' });
    return true;
  } catch {
    return false;
  }
}

/** One Tavily call. Throws on a non-OK response so the caller's try/catch can
 *  decide to fall back or return null. */
async function tavilyFetch(
  apiKey: string,
  query: string,
  opts: SearchJobRequirementsOptions,
): Promise<InterviewWebResponse> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query.slice(0, 400),
      max_results: opts.maxResults ?? 5,
      search_depth: opts.searchDepth ?? 'advanced',
      topic: 'general',
      include_answer: true,
      include_raw_content: false,
      ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
    }),
    signal: opts.signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Tavily ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    answer?: string;
    results?: Array<{ title: string; url: string; content: string; score: number }>;
  };
  return {
    query,
    answer: data.answer || undefined,
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
      score: typeof r.score === 'number' ? r.score : 0,
    })),
  };
}

export async function searchJobRequirements(
  query: string,
  options?: SearchJobRequirementsOptions,
): Promise<InterviewWebResponse | null> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey || !query.trim()) return null;
  let brand: ProductBrand;
  try {
    brand = resolveBrand(options?.brand);
  } catch {
    // An unknown brand is never treated as one that may search.
    return null;
  }
  try {
    // The same text is sent on the open-web retry below, so one check covers both.
    assertNoPiInPayload({ brand, target: TAVILY_SEARCH_URL, payload: query.slice(0, 400), knownValues: options?.knownValues });
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_WEB', 'web search not sent: the query failed the no-personal-information or residency check', {
      brand: brand.id, error: err instanceof Error ? err.message : String(err), requestId: options?.requestId,
    });
    return null;
  }
  const startedAt = Date.now();
  try {
    let resp = await tavilyFetch(apiKey, query, options ?? {});
    // A domain-restricted search can come back empty (the role isn't posted on
    // those boards right now). Transparently retry ONCE without the domain
    // filter so we still ground on the open web. At most 2 calls, only on empty.
    if (options?.includeDomains?.length && resp.results.length === 0) {
      logger.info('INTERVIEW_ENGINE_WEB', 'Tavily board search empty; retrying without domain filter', {
        query: query.slice(0, 120),
        requestId: options?.requestId,
      });
      resp = await tavilyFetch(apiKey, query, { ...options, includeDomains: undefined });
    }
    logger.info('INTERVIEW_ENGINE_WEB', 'Tavily search completed', {
      query: query.slice(0, 120),
      resultCount: resp.results.length,
      boardFiltered: !!options?.includeDomains?.length,
      responseTimeMs: Date.now() - startedAt,
      requestId: options?.requestId,
    });
    return resp;
  } catch (err) {
    logger.warn('INTERVIEW_ENGINE_WEB', 'Tavily search failed; continuing without web context', {
      query: query.slice(0, 120),
      error: err instanceof Error ? err.message : String(err),
      requestId: options?.requestId,
    });
    return null;
  }
}

/** Flatten a search response into a compact, prompt-friendly evidence block. */
export function formatWebEvidence(resp: InterviewWebResponse | null, maxChars = 2600): string {
  if (!resp) return '';
  const lines: string[] = [];
  if (resp.answer) lines.push(`Summary: ${resp.answer}`);
  for (const r of resp.results.slice(0, 5)) {
    const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 380);
    if (snippet) lines.push(`- ${r.title || r.url}: ${snippet}`);
  }
  return lines.join('\n').slice(0, maxChars);
}
