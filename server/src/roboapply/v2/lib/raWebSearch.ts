// backend/src/roboapply/v2/lib/raWebSearch.ts
//
// Minimal Tavily web-search client for the RoboApply V2 surface.
//
// The recruiter app already has `backend/src/services/WebSearchService.ts`,
// but the V2 import boundary (scripts/check-roboapply-v2-boundary.mjs) forbids
// V2 code from importing `services/*` (except `services/llm/*` +
// `services/LoggerService`). So this is a small, self-contained fork of the
// Tavily call — the boundary rule explicitly favours forking over crossing
// the line.
//
// Design contract: NEVER throws to callers. When `TAVILY_API_KEY` is missing
// or the request fails, it returns `null` and logs a warning, so the Interview
// Prompt Generator pipeline degrades gracefully (it synthesizes requirements
// from the role title + résumé alone).

import { logger } from '../../../services/LoggerService.js';

export interface RaWebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface RaWebSearchResponse {
  query: string;
  answer?: string;
  results: RaWebSearchResult[];
  responseTimeMs: number;
}

/** Tavily is usable only when an API key is configured. */
export function isRaWebSearchEnabled(): boolean {
  return !!process.env.TAVILY_API_KEY?.trim();
}

/**
 * Run one Tavily search. Returns `null` (never throws) when the key is missing
 * or the call fails — callers treat `null` as "no web context available".
 */
export async function raSearchWeb(
  query: string,
  options?: {
    maxResults?: number;
    searchDepth?: 'basic' | 'advanced';
    requestId?: string;
    signal?: AbortSignal;
  },
): Promise<RaWebSearchResponse | null> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey || !query.trim()) return null;

  const startedAt = Date.now();
  const maxResults = options?.maxResults ?? 5;
  const searchDepth = options?.searchDepth ?? 'basic';

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: query.slice(0, 400),
        max_results: maxResults,
        search_depth: searchDepth,
        topic: 'general',
        include_answer: true,
        include_raw_content: false,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Tavily API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string; score: number }>;
    };
    const responseTimeMs = Date.now() - startedAt;

    logger.info('RA_V2_WEB_SEARCH', 'Tavily search completed', {
      query: query.slice(0, 120),
      resultCount: data.results?.length ?? 0,
      responseTimeMs,
      hasAnswer: !!data.answer,
      requestId: options?.requestId,
    });

    return {
      query,
      answer: data.answer || undefined,
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        score: typeof r.score === 'number' ? r.score : 0,
      })),
      responseTimeMs,
    };
  } catch (err) {
    logger.warn('RA_V2_WEB_SEARCH', 'Tavily search failed; continuing without web context', {
      query: query.slice(0, 120),
      error: err instanceof Error ? err.message : String(err),
      requestId: options?.requestId,
    });
    return null;
  }
}

/**
 * Flatten a search response into a compact, prompt-friendly evidence block.
 * Returns '' when there's nothing useful, so prompts can conditionally include it.
 */
export function formatWebEvidence(resp: RaWebSearchResponse | null, maxChars = 2400): string {
  if (!resp) return '';
  const lines: string[] = [];
  if (resp.answer) lines.push(`Summary: ${resp.answer}`);
  for (const r of resp.results.slice(0, 5)) {
    const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 360);
    if (snippet) lines.push(`- ${r.title || r.url}: ${snippet}`);
  }
  return lines.join('\n').slice(0, maxChars);
}
