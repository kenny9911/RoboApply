// @vitest-environment node
//
// WP-35 — which links may reach Firecrawl: the SSRF guard and IMPORT_FETCH_DENYLIST.

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_FETCH_DENYLIST } from './contract.js';
import { checkImportUrl, hostMatchesPattern, importDenylist, isDeniedHost } from './urlPolicy.js';

describe('IMPORT_FETCH_DENYLIST', () => {
  it('lists every board the plan names, plus LinkedIn’s shortener', () => {
    for (const p of ['linkedin.com', 'indeed.*', 'glassdoor.*', 'zhipin.com', 'zhaopin.com', 'liepin.com', '51job.com', 'maimai.cn', '104.com.tw', '1111.com.tw', 'cake.me', 'yourator.co', 'lnkd.in', '518.com.tw', 'yes123.com.tw', 'meet.jobs']) {
      expect(DEFAULT_IMPORT_FETCH_DENYLIST).toContain(p);
    }
  });

  it.each([
    ['linkedin.com', true],
    ['www.linkedin.com', true],
    ['tw.linkedin.com', true],
    ['lnkd.in', true],
    ['indeed.com', true],
    ['uk.indeed.com', true],
    ['indeed.co.uk', true],
    ['jp.indeed.com', true],
    ['glassdoor.co.uk', true],
    ['www.glassdoor.com', true],
    ['www.zhipin.com', true],
    ['jobs.51job.com', true],
    ['www.104.com.tw', true],
    ['www.cake.me', true],
    ['www.yourator.co', true],
    // JT-5: the three Taiwan boards added with the open-data adapter (MARKET_STRATEGY §1.6).
    ['518.com.tw', true],
    ['www.518.com.tw', true],
    ['yes123.com.tw', true],
    ['www.yes123.com.tw', true],
    ['meet.jobs', true],
    ['www.meet.jobs', true],
    // A look-alike host is not the board.
    ['my518.com.tw', false],
    ['meet.jobs.example.org', false],
    ['notmeet.jobs', false],
    // 台灣就業通 is open data and its vacancy pages may be imported.
    ['job.taiwanjobs.gov.tw', false],
    ['www.taiwanjobs.gov.tw', false],
    ['free.taiwanjobs.gov.tw', false],
    ['boards.greenhouse.io', false],
    ['jobs.lever.co', false],
    ['indeedish.com', false],
    ['notlinkedin.com', false],
    ['linkedin.com.evil.example', false],
    ['indeed.example.org.cn', false],
    ['careers.acme.com', false],
  ])('%s denied=%s', (host, denied) => {
    expect(isDeniedHost(host, {})).toBe(denied);
  });

  it('adds env patterns to the built-in list (never replaces them)', () => {
    const env = { IMPORT_FETCH_DENYLIST: ' monster.* , *.seek.com.au,careers.example.org ' };
    expect(importDenylist(env)).toEqual(expect.arrayContaining(['linkedin.com', 'monster.*', 'seek.com.au', 'careers.example.org']));
    expect(isDeniedHost('www.monster.de', env)).toBe(true);
    expect(isDeniedHost('www.seek.com.au', env)).toBe(true);
    expect(isDeniedHost('linkedin.com', env)).toBe(true);
  });

  it('a `name.*` pattern needs the name as a whole label', () => {
    expect(hostMatchesPattern('myindeed.com', 'indeed.*')).toBe(false);
    expect(hostMatchesPattern('indeed', 'indeed.*')).toBe(false);
    expect(hostMatchesPattern('INDEED.COM.', 'indeed.*')).toBe(true);
  });
});

describe('checkImportUrl (SSRF guard: only public http(s) pages go to Firecrawl)', () => {
  it('accepts a public careers page', () => {
    const r = checkImportUrl('https://boards.greenhouse.io/acme/jobs/123?gh_src=x', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe('boards.greenhouse.io');
  });

  it.each([
    'ftp://example.com/job',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://localhost/admin',
    'http://foo.localhost:3621/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://10.0.0.5/jobs',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://intranet/jobs',
    'http://printer.local/',
    'http://svc.internal/',
    'https://user:pass@example.com/job',
    'https://example.com:8080/job',
    'not a url',
  ])('refuses %s as not_a_web_address', (raw) => {
    const r = checkImportUrl(raw, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_a_web_address');
  });

  it('refuses denylisted boards as blocked_site (the user pastes the text instead)', () => {
    const r = checkImportUrl('https://www.linkedin.com/jobs/view/123', {});
    expect(r).toMatchObject({ ok: false, reason: 'blocked_site', host: 'www.linkedin.com' });
  });

  it.each([
    ['https://www.518.com.tw/job-AbCdEf.html', 'www.518.com.tw'],
    ['https://518.com.tw/job-AbCdEf.html', '518.com.tw'],
    ['https://www.yes123.com.tw/wk_index/job.asp?p_id=1', 'www.yes123.com.tw'],
    ['https://yes123.com.tw/wk_index/job.asp?p_id=1', 'yes123.com.tw'],
    ['https://meet.jobs/zh-TW/jobs/1-example', 'meet.jobs'],
    ['https://www.meet.jobs/zh-TW/jobs/1-example', 'www.meet.jobs'],
  ])('JT-5: refuses %s before any fetch, with the existing reason', (raw, host) => {
    // `checkImportUrl` runs before any reader is called; the refusal is the same code every other
    // denylisted board gets, so the web shows the existing "paste the text" message.
    expect(checkImportUrl(raw, {})).toMatchObject({ ok: false, reason: 'blocked_site', host });
  });

  it('JT-5: a 台灣就業通 vacancy page is not refused by the denylist', () => {
    const r = checkImportUrl('https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=1&HIRE_ID=2', {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe('job.taiwanjobs.gov.tw');
  });

  it('allows the default ports', () => {
    expect(checkImportUrl('https://example.com:443/job', {}).ok).toBe(true);
    expect(checkImportUrl('http://example.com:80/job', {}).ok).toBe(true);
  });
});
