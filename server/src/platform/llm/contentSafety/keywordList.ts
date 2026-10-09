// server/src/platform/llm/contentSafety/keywordList.ts
//
// Versioned keyword lists for the GoApply content-safety filter (WP-24).
//
// Sources, merged in order:
//   1. BUILTIN_KEYWORD_LIST (builtinKeywords.ts), always on;
//   2. the operator's private list at CN_SAFETY_KEYWORDS_URL (https:// or
//      file:// / an absolute path), refreshed every 15 minutes. While a
//      private list is configured but has never loaded, the filter fails
//      closed (GoApply AI answers 503 ai_unavailable). Once a copy has
//      loaded, refreshes run in the background (stale-while-revalidate): a
//      check never waits on the list host, and after a failed refresh the
//      last good copy keeps serving and the refresh is retried a minute
//      later.
//
// File formats:
//   JSON  { "version": "2026-10-01", "entries": [{ "id", "term", "category", "action": "block"|"review", "scope"?: "input"|"output"|"both" }] }
//   text  one term per line; optional "term<TAB or |>category<TAB or |>action";
//         "# version: <v>" sets the version; other "#" lines are comments.
// A list without a version gets "sha256:<12 hex>" of its content, so every
// list in use is identifiable.

import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUILTIN_KEYWORD_LIST } from './builtinKeywords.js';
import { TermMatcher, normalizeForMatch, termKey } from './normalize.js';
import { ContentSafetyProviderError, type ContentSafetyStage } from './types.js';

export type KeywordAction = 'block' | 'review';
export type KeywordScope = 'input' | 'output' | 'both';

export interface KeywordEntry {
  id: string;
  term: string;
  category: string;
  action: KeywordAction;
  scope?: KeywordScope;
}

export interface KeywordList {
  version: string;
  entries: KeywordEntry[];
}

export interface KeywordHit {
  id: string;
  category: string;
  action: KeywordAction;
  /** UTF-16 offset in the original text. */
  offset: number;
}

export interface CompiledKeywordList {
  /** Combined version, e.g. "builtin-2026.10.10+ops-2026-10-01". */
  version: string;
  size: number;
  match(text: string, stage: ContentSafetyStage): KeywordHit[];
}

export const MAX_KEYWORD_LIST_BYTES = 2 * 1024 * 1024;
export const MAX_KEYWORD_ENTRIES = 50_000;
/**
 * Longest term, in characters, and also the longest a term's normalised
 * compact key may be in UTF-16 units. The stream guard re-checks at least
 * this many compact units of already-released text with each segment, so a
 * term split across two segments is always seen whole.
 */
export const MAX_TERM_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CATEGORY_PATTERN = /^[a-z0-9_]{1,40}$/;

function contentVersion(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function validEntry(e: Partial<KeywordEntry>, where: string): KeywordEntry {
  const term = typeof e.term === 'string' ? e.term.trim() : '';
  if (!term || term.length > MAX_TERM_LENGTH) throw new Error(`${where}: term must be 1-${MAX_TERM_LENGTH} characters`);
  const key = termKey(term);
  if (key && key.key.trim().replace(/ /g, '').length > MAX_TERM_LENGTH) {
    throw new Error(`${where}: term is longer than ${MAX_TERM_LENGTH} characters after normalisation`);
  }
  if (typeof e.id !== 'string' || !ID_PATTERN.test(e.id)) throw new Error(`${where}: id must match ${ID_PATTERN}`);
  const category = typeof e.category === 'string' && e.category ? e.category : 'unspecified';
  if (!CATEGORY_PATTERN.test(category)) throw new Error(`${where}: category must match ${CATEGORY_PATTERN}`);
  const action = e.action ?? 'block';
  if (action !== 'block' && action !== 'review') throw new Error(`${where}: action must be block or review`);
  const scope = e.scope ?? 'both';
  if (scope !== 'input' && scope !== 'output' && scope !== 'both') throw new Error(`${where}: scope must be input, output or both`);
  return { id: e.id, term, category, action, scope };
}

/** Parse a list file (JSON or text). Throws with a line/entry pointer on bad input. */
export function parseKeywordList(raw: string): KeywordList {
  if (Buffer.byteLength(raw, 'utf8') > MAX_KEYWORD_LIST_BYTES) throw new Error('keyword list is larger than 2 MB');
  const body = raw.replace(/^﻿/, '');
  let list: KeywordList;
  if (body.trimStart().startsWith('{')) {
    const parsed = JSON.parse(body) as { version?: unknown; entries?: unknown };
    if (!Array.isArray(parsed.entries)) throw new Error('keyword list JSON needs an "entries" array');
    const version = typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : contentVersion(body);
    list = {
      version,
      entries: parsed.entries.map((e, i) => validEntry((e ?? {}) as Partial<KeywordEntry>, `entries[${i}]`)),
    };
  } else {
    let version: string | null = null;
    const entries: KeywordEntry[] = [];
    body.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('#')) {
        const m = /^#\s*version\s*:\s*(\S.*)$/i.exec(trimmed);
        if (m) version = m[1].trim();
        return;
      }
      const [term, category, action] = trimmed.split(/\t|\|/).map((s) => s.trim());
      entries.push(
        validEntry(
          { id: `L${i + 1}`, term, category: category || undefined, action: (action || undefined) as KeywordAction | undefined },
          `line ${i + 1}`,
        ),
      );
    });
    list = { version: version ?? contentVersion(body), entries };
  }
  if (list.entries.length > MAX_KEYWORD_ENTRIES) throw new Error(`keyword list has more than ${MAX_KEYWORD_ENTRIES} entries`);
  return list;
}

interface CompiledEntry {
  id: string;
  category: string;
  action: KeywordAction;
  scope: KeywordScope;
}

/** Build one matcher over several lists. Entry ids are prefixed per list when lists are merged. */
export function compileKeywordLists(lists: KeywordList[]): CompiledKeywordList {
  const compact: Array<{ key: string; value: CompiledEntry }> = [];
  const spaced: Array<{ key: string; value: CompiledEntry }> = [];
  for (const [index, list] of lists.entries()) {
    for (const e of list.entries) {
      const k = termKey(e.term);
      if (!k) continue;
      const value: CompiledEntry = {
        id: index === 0 ? e.id : `${index}:${e.id}`,
        category: e.category,
        action: e.action,
        scope: e.scope ?? 'both',
      };
      (k.view === 'compact' ? compact : spaced).push({ key: k.key, value });
    }
  }
  const compactMatcher = new TermMatcher(compact);
  const spacedMatcher = new TermMatcher(spaced);
  return {
    version: lists.map((l) => l.version).join('+'),
    size: compactMatcher.size + spacedMatcher.size,
    match(text, stage) {
      if (!text) return [];
      const n = normalizeForMatch(text);
      const hits: KeywordHit[] = [];
      const take = (view: { map: number[] }, start: number, v: CompiledEntry, shift: number) => {
        if (v.scope !== 'both' && v.scope !== stage) return;
        const idx = Math.min(view.map.length - 1, Math.max(0, start + shift));
        hits.push({ id: v.id, category: v.category, action: v.action, offset: view.map[idx] ?? 0 });
      };
      for (const h of compactMatcher.findAll(n.compact.text)) take(n.compact, h.start, h.value, 0);
      // Spaced keys start with the padding space; the word starts one later.
      for (const h of spacedMatcher.findAll(n.spaced.text)) take(n.spaced, h.start, h.value, 1);
      hits.sort((a, b) => a.offset - b.offset);
      return hits;
    },
  };
}

/** Where the keyword list comes from. */
export interface KeywordSource {
  /** The compiled list to use now. Throws ContentSafetyProviderError when a private list is configured but unavailable. */
  get(): Promise<CompiledKeywordList>;
  /** 'builtin' or 'builtin+private'. */
  readonly kind: 'builtin' | 'builtin+private';
}

export interface KeywordSourceOptions {
  /** CN_SAFETY_KEYWORDS_URL. */
  url?: string;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => Promise<string>;
  /** Refresh interval for the private list (default 15 minutes). */
  refreshMs?: number;
  /**
   * Fetch timeout (default 3 s, below the 5 s default check timeout, so a
   * first load against a slow host fails as provider_error and is retried by
   * the next check instead of every caller waiting out the check timeout).
   */
  fetchTimeoutMs?: number;
  /** Wait before retrying a failed background refresh (default 60 s, at most refreshMs). */
  retryMs?: number;
  now?: () => number;
  /** Replace the built-in list (tests). */
  builtin?: KeywordList;
}

export const DEFAULT_KEYWORD_REFRESH_MS = 15 * 60 * 1000;
export const DEFAULT_KEYWORD_FETCH_TIMEOUT_MS = 3000;
export const DEFAULT_KEYWORD_RETRY_MS = 60 * 1000;

/** Validate a CN_SAFETY_KEYWORDS_URL value; returns a problem string or null. */
export function keywordUrlProblem(url: string): string | null {
  if (url.startsWith('/')) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'CN_SAFETY_KEYWORDS_URL is not a valid URL or absolute path';
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'file:') return null;
  return 'CN_SAFETY_KEYWORDS_URL must use https:// or file:// (or be an absolute path)';
}

async function loadRaw(url: string, opts: KeywordSourceOptions): Promise<string> {
  if (url.startsWith('/') || url.startsWith('file:')) {
    const path = url.startsWith('file:') ? fileURLToPath(url) : url;
    return (opts.readFile ?? ((p: string) => fsReadFile(p, 'utf8')))(path);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs ?? DEFAULT_KEYWORD_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json, text/plain' } });
    if (!res.ok) throw new Error(`keyword list fetch answered HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_KEYWORD_LIST_BYTES) throw new Error('keyword list is larger than 2 MB');
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** The keyword source for the configured URL (or the built-in list alone when there is none). */
export function createKeywordSource(opts: KeywordSourceOptions = {}): KeywordSource {
  const builtin = opts.builtin ?? BUILTIN_KEYWORD_LIST;
  const builtinOnly = compileKeywordLists([builtin]);
  const url = opts.url?.trim();
  if (!url) return { kind: 'builtin', get: async () => builtinOnly };

  const problem = keywordUrlProblem(url);
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? DEFAULT_KEYWORD_REFRESH_MS;
  const retryMs = Math.min(opts.retryMs ?? DEFAULT_KEYWORD_RETRY_MS, refreshMs);
  let cached: CompiledKeywordList | null = null;
  /** When the cached copy should next be refreshed. */
  let refreshAt = 0;
  let inflight: Promise<CompiledKeywordList> | null = null;

  const refresh = (): Promise<CompiledKeywordList> => {
    if (!inflight) {
      inflight = (async () => {
        try {
          const list = parseKeywordList(await loadRaw(url, opts));
          cached = compileKeywordLists([builtin, list]);
          refreshAt = now() + refreshMs;
          return cached;
        } catch (err) {
          // Back off before the next background refresh. (Before the first load succeeds there
          // is no copy to serve, so each check retries the load and fails closed meanwhile.)
          refreshAt = now() + retryMs;
          throw err;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };

  return {
    kind: 'builtin+private',
    async get() {
      if (problem) throw new ContentSafetyProviderError(problem, 'misconfigured');
      if (cached) {
        if (now() >= refreshAt && !inflight) {
          // Stale-while-revalidate: serve the last good copy now, refresh in the background.
          refresh().catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.warn('[contentSafety] keyword list refresh failed; serving the last good copy:', (err as Error)?.message ?? err);
          });
        }
        return cached;
      }
      try {
        return await refresh();
      } catch (err) {
        throw new ContentSafetyProviderError(`private keyword list unavailable: ${(err as Error).message}`);
      }
    },
  };
}
