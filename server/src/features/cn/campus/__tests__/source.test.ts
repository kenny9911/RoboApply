// @vitest-environment node
// WP-58: official-source policy (no aggregator, no intranet), the single-page
// fetch (redirect re-checks, size and type caps), page text, and a static
// guard that the area has no crawler.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CampusSourceError, checkCampusSourceUrl, fetchOfficialPage, htmlToText, isPrivateAddress, MAX_PAGE_BYTES, pageTitleOf } from '../source.js';
import { OFFICIAL_HTML } from './testkit.js';

const publicDns = async () => ['203.0.113.10'];

function res(status: number, body = '', headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }): Response {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

describe('checkCampusSourceUrl', () => {
  it('accepts an employer page', () => {
    expect(checkCampusSourceUrl('https://join.example.com/campus/2027').ok).toBe(true);
  });
  it.each([
    'https://www.yingjiesheng.com/job/1',
    'https://www.nowcoder.com/discuss/1',
    'https://www.shixiseng.com/intern/1',
    'https://xiaoyuan.zhaopin.com/x',
    'https://www.zhipin.com/job_detail/1',
    'https://cn.linkedin.com/jobs',
  ])('refuses the aggregator / job board %s', (url) => {
    const r = checkCampusSourceUrl(url);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('aggregator_source');
  });
  it.each(['http://127.0.0.1/x', 'http://localhost/x', 'ftp://example.com/x', 'https://example.com:8443/x', 'http://intranet/x', 'https://u:p@example.com/'])(
    'refuses %s as not a web address',
    (url) => {
      const r = checkCampusSourceUrl(url);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe('not_a_web_address');
    },
  );
});

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    'fd00::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::127.0.0.1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::8.8.8.8',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    '2002:c0a8:101::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1',
  ])('%s is private', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(['203.0.113.10', '8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '2002:808:808::1', '2400:3200::1'])('%s is public', (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe('fetchOfficialPage', () => {
  it('fetches one page with a plain GET and no automatic redirects', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const page = await fetchOfficialPage('https://campus.example.cn/2027', {
      resolve: publicDns,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return res(200, OFFICIAL_HTML);
      }) as typeof fetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(page.html).toContain('网申时间');
  });

  it('re-checks each redirect: onto an aggregator is refused', async () => {
    await expect(
      fetchOfficialPage('https://campus.example.cn/2027', {
        resolve: publicDns,
        fetchImpl: (async () => res(302, '', { location: 'https://www.yingjiesheng.com/x' })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ reason: 'aggregator_source' });
  });

  it('refuses a host that resolves to a private address (SSRF)', async () => {
    await expect(
      fetchOfficialPage('https://campus.example.cn/2027', { resolve: async () => ['10.1.2.3'], fetchImpl: (async () => res(200, 'x')) as typeof fetch }),
    ).rejects.toMatchObject({ reason: 'not_a_web_address' });
  });

  it('stops after three redirects', async () => {
    let n = 0;
    await expect(
      fetchOfficialPage('https://campus.example.cn/a', {
        resolve: publicDns,
        fetchImpl: (async () => {
          n += 1;
          return res(302, '', { location: `https://campus.example.cn/${n}` });
        }) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CampusSourceError);
    expect(n).toBe(4);
  });

  it('refuses errors, non-HTML bodies and oversized pages', async () => {
    const opts = (r: Response) => ({ resolve: publicDns, fetchImpl: (async () => r) as typeof fetch });
    await expect(fetchOfficialPage('https://campus.example.cn/x', opts(res(404, 'no')))).rejects.toMatchObject({ reason: 'page_unreachable' });
    await expect(fetchOfficialPage('https://campus.example.cn/x', opts(res(200, '%PDF', { 'content-type': 'application/pdf' })))).rejects.toMatchObject({
      reason: 'page_unreachable',
    });
    await expect(
      fetchOfficialPage('https://campus.example.cn/x', opts(res(200, 'a'.repeat(MAX_PAGE_BYTES + 10), { 'content-type': 'text/html' }))),
    ).rejects.toMatchObject({ reason: 'page_unreachable' });
  });
});

describe('page text', () => {
  it('drops scripts and keeps visible lines; reads the title', () => {
    const text = htmlToText(OFFICIAL_HTML);
    expect(text).toContain('网申时间：2026年9月1日-2026年10月31日 23:59');
    expect(text).not.toContain('2030年1月1日');
    expect(pageTitleOf(OFFICIAL_HTML)).toBe('示例科技2027届校园招聘官网');
    expect(htmlToText('<p>A&amp;B &#x4e2d;</p>')).toBe('A&B 中');
  });
});

describe('no crawler, no aggregator path (static guard)', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    // Code only: comments may name what the area deliberately does not use.
    .map((f) => readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
  it('imports no crawler or headless browser and calls no scraping API', () => {
    for (const src of sources) {
      expect(src).not.toMatch(/firecrawl|tavily|puppeteer|playwright|cheerio|rapidapi|sitemap/i);
    }
  });
  it('fetches only through fetchOfficialPage (one file calls fetch)', () => {
    const callers = sources.filter((src) => /\bfetch(Impl)?\(/.test(src));
    expect(callers).toHaveLength(1);
  });
});
