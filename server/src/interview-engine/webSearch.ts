// backend/src/interview-engine/webSearch.ts
//
// Self-contained Tavily client for the Interview Engine's prompt pipeline
// (requirement #4: "search the internet for job requirements first"). A small
// fork of roboapply/v2/lib/raWebSearch.ts so the engine stays standalone.
//
// Contract: NEVER throws. Returns null when TAVILY_API_KEY is missing or the
// request fails, so prompt generation degrades gracefully to role-title-only
// synthesis.

import { logger } from '../services/LoggerService.js';

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
}

/** One Tavily call. Throws on a non-OK response so the caller's try/catch can
 *  decide to fall back or return null. */
async function tavilyFetch(
  apiKey: string,
  query: string,
  opts: SearchJobRequirementsOptions,
): Promise<InterviewWebResponse> {
  const response = await fetch('https://api.tavily.com/search', {
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
