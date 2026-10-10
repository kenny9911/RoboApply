// server/src/features/jobs/import/firecrawl.ts — how an imported link is read
// (WP-35; ARCH §3.4 / threat model: "fetched by Firecrawl, not by our server
// directly; response size cap"). The one other reader is directFetch.ts, used
// only on a mainland deployment when this provider cannot be used or reached.
//
// One POST to the Firecrawl scrape API with the link; we get back the page's
// main text (markdown), its raw HTML (for the structured job data) and its
// metadata. The response body is read up to `maxBytes` and dropped beyond.
// Firecrawl is a no-PI vendor: callers run `assertNoPiInPayload` on the
// payload first (WP-15).

export const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
/** Response cap (markdown + raw HTML + metadata). */
export const FIRECRAWL_MAX_BYTES = 4 * 1024 * 1024;
/** Our wait for the API; Firecrawl gets a little less to answer within it. */
export const FIRECRAWL_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ScrapedPage {
  /** The page Firecrawl ended on (after redirects), when it says. */
  finalUrl: string | null;
  markdown: string;
  rawHtml: string;
  metadata: {
    title: string | null;
    ogTitle: string | null;
    ogSiteName: string | null;
    description: string | null;
    statusCode: number | null;
  };
}

export type ScrapeErrorKind = 'not_configured' | 'too_large' | 'http_error' | 'timeout' | 'bad_response' | 'page_error';

export class ScrapeError extends Error {
  readonly kind: ScrapeErrorKind;
  constructor(kind: ScrapeErrorKind, message: string) {
    super(message);
    this.name = 'ScrapeError';
    this.kind = kind;
  }
}

export interface ScrapeOptions {
  apiKey: string | null | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Read a response body as text, refusing more than `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new ScrapeError('too_large', `response is ${declared} bytes`);
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ScrapeError('too_large', 'response too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ScrapeError('too_large', `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

/** Scrape one page through Firecrawl. Throws ScrapeError. */
export async function scrapeJobPage(url: string, options: ScrapeOptions): Promise<ScrapedPage> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new ScrapeError('not_configured', 'FIRECRAWL_API_KEY is not set');
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? FIRECRAWL_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? FIRECRAWL_MAX_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  let status: number;
  try {
    const res = await doFetch(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'rawHtml'],
        onlyMainContent: true,
        // Firecrawl's own page timeout, inside ours.
        timeout: Math.max(5_000, timeoutMs - 5_000),
      }),
      signal: controller.signal,
    });
    status = res.status;
    text = await readCapped(res, maxBytes);
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    if (controller.signal.aborted) throw new ScrapeError('timeout', `Firecrawl did not answer in ${timeoutMs} ms`);
    throw new ScrapeError('http_error', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  if (status < 200 || status >= 300) throw new ScrapeError('http_error', `Firecrawl answered ${status}`);
  let body: { success?: unknown; data?: Record<string, unknown> };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new ScrapeError('bad_response', 'Firecrawl answered with something that is not JSON');
  }
  if (body.success === false || !body.data || typeof body.data !== 'object') throw new ScrapeError('bad_response', 'Firecrawl returned no page');
  const data = body.data;
  const meta = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;
  const statusCode = typeof meta.statusCode === 'number' ? meta.statusCode : null;
  if (statusCode !== null && statusCode >= 400) throw new ScrapeError('page_error', `the page answered ${statusCode}`);

  return {
    finalUrl: str(meta.url) ?? str(meta.sourceURL),
    markdown: typeof data.markdown === 'string' ? data.markdown : '',
    rawHtml: typeof data.rawHtml === 'string' ? data.rawHtml : typeof data.html === 'string' ? data.html : '',
    metadata: {
      title: first(meta.title),
      ogTitle: first(meta.ogTitle) ?? first(meta['og:title']),
      ogSiteName: first(meta.ogSiteName) ?? first(meta['og:site_name']),
      description: first(meta.description),
      statusCode,
    },
  };
}
