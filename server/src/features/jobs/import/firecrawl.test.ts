// @vitest-environment node
//
// WP-35 — the Firecrawl client: the only outbound call, with a response cap.

import { describe, expect, it, vi } from 'vitest';
import { FIRECRAWL_SCRAPE_URL, ScrapeError, readCapped, scrapeJobPage } from './firecrawl.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('scrapeJobPage', () => {
  it('posts the link to the Firecrawl API (never to the link itself) and maps the page', async () => {
    const fetch = vi.fn(async () =>
      json({
        success: true,
        data: {
          markdown: '# Role',
          rawHtml: '<html></html>',
          metadata: { title: 'Role | Acme', ogTitle: ['Role'], ogSiteName: 'Acme', sourceURL: 'https://acme.example/jobs/1', statusCode: 200 },
        },
      }),
    );
    const page = await scrapeJobPage('https://acme.example/jobs/1', { apiKey: 'fc-key', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FIRECRAWL_SCRAPE_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fc-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ url: 'https://acme.example/jobs/1', formats: ['markdown', 'rawHtml'] });
    expect(page).toEqual({
      finalUrl: 'https://acme.example/jobs/1',
      markdown: '# Role',
      rawHtml: '<html></html>',
      metadata: { title: 'Role | Acme', ogTitle: 'Role', ogSiteName: 'Acme', description: null, statusCode: 200 },
    });
  });

  it('refuses without a key, before any network call', async () => {
    const fetch = vi.fn();
    await expect(scrapeJobPage('https://a.example/', { apiKey: '', fetch })).rejects.toMatchObject({ kind: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps API errors, page errors and bad bodies', async () => {
    await expect(scrapeJobPage('https://a.example/', { apiKey: 'k', fetch: async () => json({}, 500) })).rejects.toMatchObject({ kind: 'http_error' });
    await expect(
      scrapeJobPage('https://a.example/', { apiKey: 'k', fetch: async () => json({ success: true, data: { metadata: { statusCode: 404 } } }) }),
    ).rejects.toMatchObject({ kind: 'page_error' });
    await expect(scrapeJobPage('https://a.example/', { apiKey: 'k', fetch: async () => new Response('<html>') })).rejects.toMatchObject({ kind: 'bad_response' });
    await expect(scrapeJobPage('https://a.example/', { apiKey: 'k', fetch: async () => json({ success: false }) })).rejects.toMatchObject({ kind: 'bad_response' });
    await expect(
      scrapeJobPage('https://a.example/', {
        apiKey: 'k',
        fetch: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    ).rejects.toMatchObject({ kind: 'http_error' });
  });

  it('times out', async () => {
    const fetch = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(scrapeJobPage('https://a.example/', { apiKey: 'k', fetch, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('drops a response larger than the cap', async () => {
    const big = 'x'.repeat(2048);
    await expect(
      scrapeJobPage('https://a.example/', { apiKey: 'k', fetch: async () => json({ success: true, data: { markdown: big } }), maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ScrapeError);
  });
});

describe('readCapped', () => {
  it('refuses a declared length over the cap without reading', async () => {
    const res = new Response('abc', { headers: { 'content-length': '999999' } });
    await expect(readCapped(res, 10)).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('stops a stream at the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 5; i += 1) c.enqueue(new Uint8Array(400));
        c.close();
      },
    });
    await expect(readCapped(new Response(stream), 1000)).rejects.toMatchObject({ kind: 'too_large' });
    expect(await readCapped(new Response('héllo'), 100)).toBe('héllo');
  });
});
