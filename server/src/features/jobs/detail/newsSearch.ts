// server/src/features/jobs/detail/newsSearch.ts — company news through Tavily
// (F-JOB-04 V2; TASK_PLAN.md WP-34).
//
// Search results, labelled "Search results, not verified by %BRAND%" in the
// UI; we keep only the title, link, publisher host and date the result
// states. The query carries the company name only (no personal information),
// and `assertNoPiInPayload` checks the brand may reach Tavily at all
// (WP-15 residency) before any request. Never throws: a missing key, a
// refused egress or a failed call answers null ("no news").

import { assertNoPiInPayload } from '../../../platform/residency/index.js';
import type { ProductBrand } from '../../../platform/brand/registry.js';
import type { EnvSource } from '../../../platform/brand/brandEnv.js';
import type { CompanyNewsItem } from './contract.js';

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
export const NEWS_MAX_RESULTS = 5;
export const NEWS_DAYS = 90;
export const NEWS_CACHE_MS = 6 * 60 * 60 * 1000;
/** Most companies kept in the in-process cache (least recently used goes first). */
export const NEWS_CACHE_MAX = 500;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface NewsSearchDeps {
  env?: EnvSource;
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
}

export function tavilyConfigured(env: EnvSource = process.env): boolean {
  return !!env.TAVILY_API_KEY?.trim();
}

function publisherOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Pure: Tavily results → news items (drops rows without a usable link or title). */
export function toNewsItems(results: unknown): CompanyNewsItem[] {
  if (!Array.isArray(results)) return [];
  const out: CompanyNewsItem[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url.trim() : '';
    const title = typeof o.title === 'string' ? o.title.replace(/\s+/g, ' ').trim() : '';
    const publisher = url ? publisherOf(url) : null;
    if (!url || !title || !publisher) continue;
    out.push({ title: title.slice(0, 200), url, publisher, publishedAt: isoOrNull(o.published_date) });
    if (out.length >= NEWS_MAX_RESULTS) break;
  }
  return out;
}

const cache = new Map<string, { at: number; items: CompanyNewsItem[] }>();

/** Test seam. */
export function clearNewsCache(): void {
  cache.clear();
}

/** Test seam: entries currently cached. */
export function newsCacheSize(): number {
  return cache.size;
}

/** A fresh hit (moved to most recent), or null; a stale entry is dropped on read. */
function cacheGet(key: string, now: number): CompanyNewsItem[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  if (now - hit.at >= NEWS_CACHE_MS) return null;
  cache.set(key, hit);
  return hit.items;
}

function cacheSet(key: string, now: number, items: CompanyNewsItem[]): void {
  cache.delete(key);
  cache.set(key, { at: now, items });
  while (cache.size > NEWS_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function searchCompanyNews(brand: ProductBrand, companyName: string, deps: NewsSearchDeps = {}): Promise<CompanyNewsItem[] | null> {
  const env = deps.env ?? process.env;
  const key = env.TAVILY_API_KEY?.trim();
  const name = companyName.replace(/\s+/g, ' ').trim();
  if (!key || !name) return null;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const cacheKey = `${brand.id}:${name.toLowerCase()}`;
  const hit = cacheGet(cacheKey, now);
  if (hit) return hit;

  const query = `"${name.replace(/"/g, '')}" company news`;
  try {
    assertNoPiInPayload({ brand, target: TAVILY_SEARCH_URL, payload: query, env });
  } catch {
    return null;
  }
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 8000);
  try {
    const res = await doFetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        topic: 'news',
        days: NEWS_DAYS,
        max_results: NEWS_MAX_RESULTS,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: unknown };
    const items = toNewsItems(data?.results);
    cacheSet(cacheKey, now, items);
    return items;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
