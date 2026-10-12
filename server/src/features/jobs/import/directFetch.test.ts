// @vitest-environment node
//
// The plain server read of an imported link (mainland deployments; G127).
// Our server opens this connection itself, so these are the SSRF rules: the
// URL policy on every hop, every resolved address public, the connection
// pinned to the checked address, redirects by hand, caps and content type.
// DNS and the HTTP exchange are fakes: no test opens a connection.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_MAX_BYTES,
  MAX_REDIRECTS,
  charsetOf,
  fetchJobPageDirect,
  isPublicAddress,
  mainHtmlOf,
  pinnedGet,
  toScrapedPage,
  type DirectFetchOptions,
  type DirectResponse,
  type ResolvedAddress,
} from './directFetch.js';
import { extractDraft } from './extract.js';
import { ScrapeError } from './firecrawl.js';

const PUBLIC: ResolvedAddress = { address: '203.0.114.10', family: 4 };
const LINK = 'https://careers.example.cn/jobs/1';
const TEXT = '负责数据平台的建设与运维，与产品和研发团队紧密协作，独立负责数据管道的设计、开发与上线，保障数据质量与时效。';
const HTML = `<html><head><title>数据工程师 - 示例科技招聘</title><meta name="description" content="示例科技招聘"><meta property="og:site_name" content="示例科技"></head><body><nav>首页 职位 关于我们</nav><main><h1>数据工程师</h1><p>${TEXT}</p></main><footer>© 示例科技</footer><script>window.x = 1</script></body></html>`;

const ok = (body: string | Buffer, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }, status = 200): DirectResponse => ({
  status,
  headers,
  body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
});
const redirect = (location: string, status = 302): DirectResponse => ({ status, headers: { location }, body: Buffer.alloc(0) });

function setup(responses: Array<DirectResponse | Error>, dnsTable: Record<string, ResolvedAddress[]> = {}) {
  const resolve = vi.fn(async (host: string) => dnsTable[host] ?? [PUBLIC]);
  const queue = [...responses];
  const request = vi.fn(async (_url: URL, _address: ResolvedAddress, _limits: { timeoutMs: number; maxBytes: number; signal: AbortSignal }) => {
    const next = queue.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  });
  const options: DirectFetchOptions = { env: {}, resolve, request };
  return { resolve, request, options };
}

const kindOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e) => (e instanceof ScrapeError ? e.kind : `other:${String(e)}`),
  );

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:10.0.0.1', // an internal IPv4 address carried in IPv6
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 to an internal address
    '2002:a00:1::', // 6to4
    'not an address',
    '',
    'fe80::1%eth0',
  ])('%s is not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['203.0.114.10', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2400:3200::1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('fetchJobPageDirect: what is read', () => {
  it('a reachable HTML page becomes the page the extractor reads: main text without site chrome, the title, the structured data', async () => {
    const { options, request, resolve } = setup([ok(HTML)]);
    const page = await fetchJobPageDirect(LINK, options);
    expect(resolve).toHaveBeenCalledWith('careers.example.cn');
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.finalUrl).toBe(LINK);
    expect(page.metadata).toMatchObject({ title: '数据工程师 - 示例科技招聘', ogSiteName: '示例科技', description: '示例科技招聘', statusCode: 200 });
    expect(page.markdown).toContain(TEXT);
    expect(page.markdown).not.toMatch(/首页|关于我们|©|window\.x/);
    // The extractor reads only structured data from the raw document: this page has none.
    expect(page.rawHtml).toBe('');
    // The extractor gets a draft out of it.
    const { draft, foundAnything } = extractDraft(page, LINK);
    expect(foundAnything).toBe(true);
    expect(draft.description).toContain('负责数据平台的建设与运维');
    expect(draft.applyUrl).toBe(LINK);
  });

  it('the connection is pinned to the address that was checked, and the request carries no credentials', async () => {
    const { options, request } = setup([ok(HTML)], { 'careers.example.cn': [{ address: '203.0.114.77', family: 4 }] });
    await fetchJobPageDirect(LINK, options);
    const [url, address, limits] = request.mock.calls[0]!;
    expect(url.toString()).toBe(LINK);
    expect(address).toEqual({ address: '203.0.114.77', family: 4 });
    expect(limits.maxBytes).toBe(DIRECT_MAX_BYTES);
    expect(limits.timeoutMs).toBeGreaterThan(0);
  });

  it('a mainland page in GBK is decoded by the charset it declares (header, else its own meta)', async () => {
    const gbk = Buffer.from([0xca, 0xfd, 0xbe, 0xdd]); // "数据" in GBK
    const viaHeader = await fetchJobPageDirect(LINK, setup([ok(Buffer.concat([Buffer.from('<html><body><main><p>'), gbk, Buffer.from('</p></main></body></html>')]), { 'content-type': 'text/html; charset=GBK' })]).options);
    expect(viaHeader.markdown).toBe('数据');
    const viaMeta = await fetchJobPageDirect(
      LINK,
      setup([ok(Buffer.concat([Buffer.from('<html><head><meta charset="gb2312"></head><body><main><p>'), gbk, Buffer.from('</p></main></body></html>')]), { 'content-type': 'text/html' })]).options,
    );
    expect(viaMeta.markdown).toBe('数据');
    expect(charsetOf('text/html', Buffer.from('<html><body>x</body></html>'))).toBe('utf-8');
    expect(charsetOf('text/html; charset="UTF-8"', Buffer.alloc(0))).toBe('utf-8');
  });

  it('a plain-text page is kept as text; anything that is not a page is refused', async () => {
    const plain = await fetchJobPageDirect(LINK, setup([ok('数据工程师\n负责数据平台', { 'content-type': 'text/plain; charset=utf-8' })]).options);
    expect(plain).toMatchObject({ markdown: '数据工程师\n负责数据平台', rawHtml: '' });
    for (const type of ['application/pdf', 'application/json', 'image/png', 'application/octet-stream']) {
      expect(await kindOf(fetchJobPageDirect(LINK, setup([ok('x', { 'content-type': type })]).options)), type).toBe('bad_response');
    }
  });

  it('structured job data on the page reaches the extractor (and only that part of the raw document is kept)', async () => {
    const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: '后端工程师', hiringOrganization: { '@type': 'Organization', name: '示例科技' }, description: `<p>${TEXT}</p>` });
    const html = `<html><head><title>招聘</title><script>var big = "<script ";</script><script type="application/ld+json">${ld}</script></head><body><main><p>页面正文</p></main></body></html>`;
    const page = await fetchJobPageDirect(LINK, setup([ok(html)]).options);
    expect(page.rawHtml).toBe(`<script type="application/ld+json">${ld}</script>`);
    const { draft } = extractDraft(page, LINK);
    // (Structured descriptions go through the shared width-folding reader, as on the provider path.)
    expect(draft).toMatchObject({ title: '后端工程师', company: '示例科技', description: TEXT.normalize('NFKC'), sources: { title: 'job_data', company: 'job_data', description: 'job_data' } });
  });

  // One crafted page must not hold the API process (the plain read runs in it). Each of these inputs made the
  // first, pattern-based reader take seconds at 100 KB and many minutes at the 2 MB cap.
  it.each(['<meta ', '<!--', '<li ', '<script>', '<script ', '<title ', '<a href="', '![', '[a](', '\u3000', 'first name \u3000'])('a 2 MB page of %j is read, and its draft built, in milliseconds', (unit) => {
    const body = unit.repeat(Math.ceil(DIRECT_MAX_BYTES / unit.length)).slice(0, DIRECT_MAX_BYTES);
    for (const [doc, plain] of [[body, false], [`<html><head>${body}</head><body><main>${body}</main></body></html>`, false], [body, true]] as const) {
      const t0 = performance.now();
      const page = toScrapedPage(doc, LINK, 200, plain);
      const read = performance.now() - t0;
      extractDraft(page, LINK);
      const built = performance.now() - t0 - read;
      expect(read, `read ${plain ? 'text' : 'html'}`).toBeLessThan(200);
      expect(built, `draft ${plain ? 'text' : 'html'}`).toBeLessThan(400);
    }
  });

  it('a plain-text page has its blank runs folded like an HTML page', () => {
    expect(toScrapedPage('数据工程师  \t \n\n\n\n负责\u3000\u3000数据平台 ', LINK, 200, true).markdown).toBe('数据工程师\n\n负责 数据平台');
  });

  it('mainHtmlOf prefers <main>, then <article>, then <body>, and drops scripts, comments and site chrome', () => {
    expect(mainHtmlOf('<body><nav>n</nav><article><p>a</p></article><aside>s</aside></body>')).toBe('<p>a</p>');
    expect(mainHtmlOf('<body><header>h</header><p>b</p><!-- c --><form>f</form><footer>f</footer></body>').replace(/\s+/g, '')).toBe('<p>b</p>');
    expect(toScrapedPage('<html><body><p>only text</p></body></html>', LINK, 200).metadata.title).toBeNull();
  });
});

describe('fetchJobPageDirect: what is refused (SSRF)', () => {
  it('a link the URL policy refuses is never resolved or requested', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1/admin',
      'http://[::1]/admin',
      'http://localhost/admin',
      'http://intranet/jobs',
      'http://db.internal/jobs',
      'https://user:pass@careers.example.cn/jobs/1',
      'https://careers.example.cn:8443/jobs/1',
      'ftp://careers.example.cn/jobs/1',
      'file:///etc/passwd',
      'https://www.zhipin.com/job_detail/abc.html', // a listed board is never read
      'https://www.linkedin.com/jobs/view/1',
    ]) {
      const { options, resolve, request } = setup([ok(HTML)]);
      expect(await kindOf(fetchJobPageDirect(url, options)), url).toBe('page_error');
      expect(resolve, url).not.toHaveBeenCalled();
      expect(request, url).not.toHaveBeenCalled();
    }
  });

  it('a public-looking name that resolves to an internal address is refused before any request (also when only one of its addresses is internal)', async () => {
    for (const addresses of [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '::1', family: 6 }],
      [{ address: '::ffff:192.168.1.10', family: 6 }],
      [PUBLIC, { address: '10.0.0.5', family: 4 }],
      [],
    ] as ResolvedAddress[][]) {
      const { options, request } = setup([ok(HTML)], { 'careers.example.cn': addresses });
      expect(await kindOf(fetchJobPageDirect(LINK, options)), JSON.stringify(addresses)).toBe('page_error');
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('a host that does not resolve is "not reachable"', async () => {
    const { options, request } = setup([ok(HTML)]);
    options.resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await kindOf(fetchJobPageDirect(LINK, options))).toBe('http_error');
    expect(request).not.toHaveBeenCalled();
  });

  it('every redirect hop goes through the same checks: to an internal name, an internal address, or a listed board, the read stops', async () => {
    // To an IP literal / metadata endpoint.
    let s = setup([redirect('http://169.254.169.254/latest/meta-data')]);
    expect(await kindOf(fetchJobPageDirect(LINK, s.options))).toBe('page_error');
    expect(s.request).toHaveBeenCalledTimes(1);
    // To a name that resolves internally.
    s = setup([redirect('https://jobs.partner.example/x')], { 'jobs.partner.example': [{ address: '10.9.9.9', family: 4 }] });
    expect(await kindOf(fetchJobPageDirect(LINK, s.options))).toBe('page_error');
    expect(s.request).toHaveBeenCalledTimes(1);
    // To a listed board.
    s = setup([redirect('https://www.zhipin.com/job_detail/abc.html')]);
    expect(await kindOf(fetchJobPageDirect(LINK, s.options))).toBe('page_error');
    // To another scheme.
    s = setup([redirect('file:///etc/passwd')]);
    expect(await kindOf(fetchJobPageDirect(LINK, s.options))).toBe('page_error');
  });

  it('a redirect to another public page is followed (relative ones too), each hop resolved again; too many stop', async () => {
    const s = setup([redirect('/jobs/1/detail', 301), redirect('https://jobs.example.cn/p/1', 307), ok(HTML)]);
    const page = await fetchJobPageDirect(LINK, s.options);
    expect(page.finalUrl).toBe('https://jobs.example.cn/p/1');
    expect(s.request.mock.calls.map((c) => c[0].toString())).toEqual([LINK, 'https://careers.example.cn/jobs/1/detail', 'https://jobs.example.cn/p/1']);
    expect(s.resolve.mock.calls.map((c) => c[0])).toEqual(['careers.example.cn', 'careers.example.cn', 'jobs.example.cn']);
    const loop = setup(Array.from({ length: MAX_REDIRECTS + 1 }, () => redirect('/again')));
    expect(await kindOf(fetchJobPageDirect(LINK, loop.options))).toBe('http_error');
    expect(loop.request).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    expect(await kindOf(fetchJobPageDirect(LINK, setup([redirect('')]).options))).toBe('http_error');
  });

  it('error statuses, oversized bodies, slow hosts and transport errors never return a page', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      expect(await kindOf(fetchJobPageDirect(LINK, setup([ok('x', { 'content-type': 'text/html' }, status)]).options)), String(status)).toBe('http_error');
    }
    expect(await kindOf(fetchJobPageDirect(LINK, { ...setup([ok(Buffer.alloc(64))]).options, maxBytes: 32 }))).toBe('too_large');
    expect(await kindOf(fetchJobPageDirect(LINK, setup([new ScrapeError('too_large', 'cap')]).options))).toBe('too_large');
    expect(await kindOf(fetchJobPageDirect(LINK, setup([new ScrapeError('timeout', 'slow')]).options))).toBe('timeout');
    expect(await kindOf(fetchJobPageDirect(LINK, setup([new Error('ECONNRESET')]).options))).toBe('http_error');
    // The time limit covers the whole read, DNS included.
    const slow = setup([ok(HTML)]);
    slow.options.resolve = () => new Promise((r) => setTimeout(() => r([PUBLIC]), 40));
    expect(await kindOf(fetchJobPageDirect(LINK, { ...slow.options, timeoutMs: 10 }))).toBe('timeout');
    expect(slow.request).not.toHaveBeenCalled();
  });
});

// The real GET, against a server on the loopback interface of this process (no outside network).
// The URL names a host that does not exist: the request can only arrive if the socket really
// connects to the pinned address instead of resolving the name.
describe('pinnedGet (node http, pinned socket)', () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const limits = (over: Partial<{ timeoutMs: number; maxBytes: number }> = {}) => ({ timeoutMs: 2_000, maxBytes: 64 * 1024, signal: new AbortController().signal, ...over });
  const at = (path: string) => new URL(`http://careers.does-not-resolve.invalid:${port}${path}`);
  const loopback = { address: '127.0.0.1', family: 4 };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><main><p>数据工程师</p></main></body></html>');
      } else if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync('<p>压缩页面</p>'));
      } else if (req.url === '/bomb') {
        // 2 MB of zeros in a few kB: the cap counts the decompressed bytes.
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024)));
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(Buffer.alloc(200 * 1024, 0x61));
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end('secret body that must not be read');
      } else if (req.url === '/slow') {
        // Never answers.
      } else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects to the pinned address (the name is never resolved), sends the host name, an honest user agent and no credentials', async () => {
    const res = await pinnedGet(at('/page'), loopback, limits());
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toContain('数据工程师');
    const req = seen.at(-1)!;
    expect(req.headers.host).toBe(`careers.does-not-resolve.invalid:${port}`);
    expect(req.headers['user-agent']).toMatch(/JobLinkReader/);
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
  });

  it('decodes a compressed page, and caps the size after decompression', async () => {
    expect((await pinnedGet(at('/gzip'), loopback, limits())).body.toString('utf8')).toBe('<p>压缩页面</p>');
    expect(await kindOf(pinnedGet(at('/bomb'), loopback, limits()))).toBe('too_large');
    expect(await kindOf(pinnedGet(at('/big'), loopback, limits()))).toBe('too_large');
  });

  it('a redirect or an error status is reported without reading its body; a host that never answers times out', async () => {
    const moved = await pinnedGet(at('/moved'), loopback, limits());
    expect(moved.status).toBe(302);
    expect(moved.headers.location).toBe('http://169.254.169.254/latest/meta-data');
    expect(moved.body.byteLength).toBe(0);
    expect((await pinnedGet(at('/missing'), loopback, limits())).status).toBe(404);
    expect(await kindOf(pinnedGet(at('/slow'), loopback, limits({ timeoutMs: 150 })))).toBe('timeout');
  });

  it('through fetchJobPageDirect the same server is unreachable by name: the URL policy refuses a non-web port and a loopback name first', async () => {
    expect(await kindOf(fetchJobPageDirect(`http://careers.does-not-resolve.invalid:${port}/page`, { env: {}, resolve: async () => [loopback] }))).toBe('page_error');
    expect(await kindOf(fetchJobPageDirect('http://careers.example.cn/page', { env: {}, resolve: async () => [loopback] }))).toBe('page_error');
  });
});
