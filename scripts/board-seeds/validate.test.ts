// @vitest-environment node
//
// scripts/board-seeds/validate.mjs (MKT-4S; MARKET_STRATEGY.md M-1, 1.2
// "Company list for tier 0"; JI-3; D3). The validator turns a guessed
// employer board into a fact by asking the board's documented public API.
//
// No test reaches the network: every request goes to a fake fetch. The boards,
// companies and postings below are SYNTHETIC. Time is the fake clock's, so the
// politeness rules (2 in flight per host, 300 ms between requests to a host)
// are measured exactly and never depend on the machine's load.
//
// Parity with the server (the same User-Agent text, the same listing URLs, the
// same reading of "is this posting in mainland China?") is tested next to the
// server code, in server/src/features/jobs/sources/atsPublic/seeds.test.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error: a plain .mjs script, no type declarations
import * as v from './validate.mjs';
// @ts-expect-error: a plain .mjs script, no type declarations
import * as places from './places.mjs';

const SCRIPT = fileURLToPath(new URL('./validate.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));

type Init = { method?: string; headers?: Record<string, string>; redirect?: string; signal?: AbortSignal };
type Call = { url: string; host: string; init: Init; startedAt: number; endedAt: number };
type Answer = { status: number; body?: unknown; latencyMs?: number; throws?: boolean };

/** Text no report may ever hold: the synthetic postings carry it as title and description. */
const POSTING_TITLE = 'SYNTHETIC-TITLE Senior Lighthouse Keeper';
const POSTING_TEXT = 'SYNTHETIC-TEXT You will polish the lamp every evening.';

const gh = (location: string, company = 'Acme', id = 1) => ({ id, title: POSTING_TITLE, company_name: company, location: { name: location }, content: POSTING_TEXT, absolute_url: 'https://example.invalid/1' });
const leverPosting = (id: string, location: string, country: string | null = null, all: string[] = []) => ({ id, text: POSTING_TITLE, country, categories: { location, allLocations: all }, descriptionPlain: POSTING_TEXT });
const ashbyJob = (id: string, location: string, addressCountry: string | null, over: Record<string, unknown> = {}) => ({
  id,
  title: POSTING_TITLE,
  location,
  address: addressCountry ? { postalAddress: { addressCountry } } : undefined,
  descriptionPlain: POSTING_TEXT,
  ...over,
});
const srRow = (id: string, country: string, company = 'Harbor Foods') => ({ id, name: POSTING_TITLE, company: { identifier: 'HarborFoods', name: company }, location: { city: 'SYNTHETIC', country } });

/** A fake fetch: answers by exact URL, records every call with the fake clock's times and how many ran at once per host. */
function fakeFetch(routes: Record<string, Answer | Answer[] | ((url: string) => Answer)>, fallback: Answer = { status: 404 }) {
  const calls: Call[] = [];
  const active = new Map<string, number>();
  const peak = new Map<string, number>();
  const served = new Map<string, number>();
  const fetch = async (url: string, init: Init) => {
    const host = new URL(url).hostname;
    const call: Call = { url, host, init, startedAt: Date.now(), endedAt: Number.NaN };
    calls.push(call);
    active.set(host, (active.get(host) ?? 0) + 1);
    peak.set(host, Math.max(peak.get(host) ?? 0, active.get(host)!));
    const route = routes[url];
    const n = served.get(url) ?? 0;
    served.set(url, n + 1);
    const answer: Answer = typeof route === 'function' ? route(url) : Array.isArray(route) ? (route[Math.min(n, route.length - 1)] ?? fallback) : (route ?? fallback);
    await new Promise((resolve) => setTimeout(resolve, answer.latencyMs ?? 40));
    active.set(host, active.get(host)! - 1);
    call.endedAt = Date.now();
    if (answer.throws) throw new TypeError('fetch failed');
    return { status: answer.status, ok: answer.status === 200, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {})) };
  };
  return { fetch, calls, peak, to: (host: string) => calls.filter((c) => c.host === host) };
}

/** Runs a promise to its end on the fake clock. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const guard = p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 200_000 && !settled; i += 1) await vi.advanceTimersByTimeAsync(20);
  await guard;
  return p;
}

const candidate = (over: Record<string, unknown> = {}) => ({ ats: 'greenhouse', token: 'acme', employer: 'Acme', aliases: [], countries: [], ...over });
const GH = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
const LEVER = (token: string, page = 0, host = 'api.lever.co') => `https://${host}/v0/postings/${token}?mode=json&skip=${page * 100}&limit=100`;
const ASHBY = (token: string) => `https://api.ashbyhq.com/posting-api/job-board/${token}`;
const SR = (token: string, page = 0, country = '') => `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${page * 100}${country ? `&country=${country}` : ''}`;

async function check(c: Record<string, unknown>, routes: Parameters<typeof fakeFetch>[0], opts: Record<string, unknown> = {}) {
  const net = fakeFetch(routes);
  const client = v.createClient({ fetchImpl: net.fetch, agent: 'TestAgent/1.0 (+https://example.invalid)', ...opts });
  const result = await drive(v.validateCandidate(candidate(c), client, { pages: (opts.pages as number) ?? 10 }) as Promise<Record<string, unknown>>);
  return { result, net, client };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2031-05-05T00:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the command line', () => {
  it('--help documents the inputs and the politeness rules, and asks nothing', async () => {
    for (const word of ['--candidates', '--date', '--out', '--max', '--pages', '"ats"', '"token"', '"employer"', '"aliases"', '"aliasSource"', '"countries"', 'default 800', '2 requests in flight per host', 'no retry of a 404']) {
      expect(v.USAGE, word).toContain(word);
    }
    const net = fakeFetch({});
    const printed: string[] = [];
    expect(await v.main(['--help'], { stdout: (l: string) => printed.push(l), fetch: net.fetch })).toBe(0);
    expect(printed.join('\n')).toBe(v.USAGE);
    expect(net.calls).toHaveLength(0);
  });

  it('`node scripts/board-seeds/validate.mjs --help` prints the usage and exits 0', () => {
    vi.useRealTimers();
    const run = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(v.USAGE);
  });

  it('needs the candidates, a real date and the report path; the date is an argument, never the clock', () => {
    expect(() => v.parseArgs([])).toThrow(/--candidates is required/);
    expect(() => v.parseArgs(['--candidates', 'c.jsonl'])).toThrow(/--date is required/);
    expect(() => v.parseArgs(['--candidates', 'c.jsonl', '--date', '2026-02-30', '--out', 'r.json'])).toThrow(/real day/);
    expect(() => v.parseArgs(['--candidates', 'c.jsonl', '--date', 'today', '--out', 'r.json'])).toThrow(/real day/);
    expect(() => v.parseArgs(['--candidates', 'c.jsonl', '--date', '2026-10-11'])).toThrow(/--out is required/);
    expect(v.parseArgs(['--candidates', 'c.jsonl', '--date', '2026-10-11', '--out', 'r.json'])).toMatchObject({ max: 800, pages: 10, pauseMs: 300, fresh: false, only: null });
    expect(v.parseArgs(['--candidates', 'c', '--date', '2026-10-11', '--out', 'r', '--max', '50', '--pages', '1', '--only', 'lever,ashby'])).toMatchObject({ max: 50, pages: 1, only: ['lever', 'ashby'] });
  });

  it('the pause can be made longer, never shorter than 300 ms; unknown arguments and systems are refused', () => {
    const base = ['--candidates', 'c', '--date', '2026-10-11', '--out', 'r'];
    expect(v.parseArgs([...base, '--pause', '1000']).pauseMs).toBe(1000);
    expect(() => v.parseArgs([...base, '--pause', '100'])).toThrow(/between 300/);
    expect(() => v.parseArgs([...base, '--max', '0'])).toThrow(/between 1/);
    expect(() => v.parseArgs([...base, '--only', 'workday'])).toThrow(/unknown job-board system/);
    expect(() => v.parseArgs([...base, '--key', 'x'])).toThrow(/unknown argument/);
  });
});

describe('the candidates file', () => {
  it('reads JSON lines, skips blanks and # lines, and keeps aliases and SmartRecruiters countries', () => {
    const { candidates, errors } = v.parseCandidates(
      ['# SYNTHETIC', '', '{"ats":"greenhouse","token":"acme","employer":"Acme"}', '{"ats":"lever","token":"pine-2","employer":"Pine Cloud","aliases":["pine-2"]}', '{"ats":"smartrecruiters","token":"HarborFoods","employer":"Harbor Foods","countries":["TW","CN"]}'].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(candidates).toEqual([
      { ats: 'greenhouse', token: 'acme', employer: 'Acme', aliases: [], countries: [] },
      { ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], countries: [] },
      { ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods', aliases: [], countries: ['CN', 'TW'] },
    ]);
    expect(candidates.map(v.candidateKey)).toEqual(['greenhouse:acme', 'lever:pine-2', 'smartrecruiters:HarborFoods@CN,TW']);
  });

  it('keeps the document that confirms a board id for an employer (aliasSource), on the systems that state no company name', () => {
    const { candidates, errors } = v.parseCandidates(
      [
        '{"ats":"lever","token":"pine-2","employer":"Pine Cloud","aliases":["pine-2"],"aliasSource":" docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5 "}',
        '{"ats":"ashby","token":"pine.com","employer":"Pine","aliases":["pine.com"],"aliasSource":"docs/notes/boards.md"}',
        // Refused: a system whose answer states the company needs no such source; a source without the alias it is for; a source that is no document.
        '{"ats":"greenhouse","token":"acme","employer":"Acme","aliases":["Acme Robotics"],"aliasSource":"docs/x.md 1"}',
        '{"ats":"lever","token":"quiet","employer":"Quiet Mill","aliasSource":"docs/x.md 1"}',
        '{"ats":"lever","token":"quiet-2","employer":"Quiet Mill","aliases":["quiet-2"],"aliasSource":"I remember it"}',
        '{"ats":"lever","token":"quiet-3","employer":"Quiet Mill","aliases":["quiet-3"],"aliasSource":"https://example.invalid/careers"}',
        '{"ats":"lever","token":"quiet-4","employer":"Quiet Mill","aliases":["quiet-4"],"aliasSource":7}',
      ].join('\n'),
    );
    expect(candidates).toEqual([
      { ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], countries: [], aliasSource: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5' },
      { ats: 'ashby', token: 'pine.com', employer: 'Pine', aliases: ['pine.com'], countries: [], aliasSource: 'docs/notes/boards.md' },
    ]);
    expect(errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(errors.map((e: { why: string }) => e.why).join(' | ')).toMatch(/lever, lever_eu and ashby only.*needs the alias.*document of this repository.*document of this repository.*document of this repository/);
  });

  it('the committed candidates file parses, and every alias source in it is a document of this repository that names the board id', () => {
    const { candidates, errors } = v.parseCandidates(readFileSync(`${REPO}scripts/board-seeds/candidates.jsonl`, 'utf8'));
    expect(errors).toEqual([]);
    const sourced = candidates.filter((c: { aliasSource?: string }) => c.aliasSource);
    expect(sourced.length).toBeGreaterThan(0);
    for (const c of sourced as Array<{ ats: string; token: string; employer: string; aliasSource: string }>) {
      const file = c.aliasSource.split(/\s/)[0]!;
      expect(existsSync(`${REPO}${file}`), `${c.ats}/${c.token}: ${file}`).toBe(true);
      const text = readFileSync(`${REPO}${file}`, 'utf8');
      expect(text, `${c.ats}/${c.token} in ${file}`).toContain(`\`${c.token}\``);
      expect(text, `${c.employer} in ${file}`).toContain(c.employer);
    }
  });

  it('names every line that is not a candidate, with its number', () => {
    const lines = [
      'not json',
      '{"ats":"workday","token":"acme","employer":"Acme"}',
      '{"ats":"greenhouse","token":"acme corp","employer":"Acme"}',
      '{"ats":"greenhouse","token":"../etc","employer":"Acme"}',
      '{"ats":"greenhouse","token":"acme"}',
      '{"ats":"greenhouse","token":"acme","employer":"..."}',
      '{"ats":"greenhouse","token":"acme","employer":"Acme","countries":["CN"]}',
      '{"ats":"smartrecruiters","token":"Acme","employer":"Acme","countries":["cn"]}',
      '{"ats":"greenhouse","token":"acme","employer":"Acme","aliases":"ACME"}',
      '{"ats":"greenhouse","token":"acme","employer":"Acme"}',
      '{"ats":"greenhouse","token":"acme","employer":"Acme Again"}',
      '["greenhouse","acme"]',
    ];
    const { candidates, errors } = v.parseCandidates(lines.join('\n'));
    expect(candidates).toHaveLength(1);
    expect(errors.map((e: { line: number }) => e.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12]);
    expect(errors.map((e: { why: string }) => e.why).join(' | ')).toMatch(/not JSON.*unknown job-board system.*invalid board id.*invalid board id.*no employer name.*no letter or digit.*smartrecruiters only.*ISO alpha-2.*aliases.*listed twice.*not an object/);
  });

  it('a file with a bad line asks nothing and exits 2', async () => {
    const net = fakeFetch({});
    const said: string[] = [];
    const code = await v.main(['--candidates', 'c.jsonl', '--date', '2026-10-11', '--out', 'r.json'], {
      readFile: () => '{"ats":"greenhouse","token":"acme","employer":"Acme"}\n{"ats":"workday","token":"x","employer":"X"}',
      exists: () => false,
      writeFile: () => {
        throw new Error('nothing may be written');
      },
      fetch: net.fetch,
      stdout: () => undefined,
      stderr: (l: string) => said.push(l),
    });
    expect(code).toBe(2);
    expect(said.join('\n')).toMatch(/c\.jsonl:2: unknown job-board system/);
    expect(net.calls).toHaveLength(0);
  });
});

describe('is the board this employer\'s?', () => {
  it('normalizeName sets aside case, accents, punctuation, a leading "the" and legal forms at the end', () => {
    const same = [
      ['Stripe, Inc.', 'stripe'],
      ['STRIPE', 'stripe'],
      ['The Trade Desk', 'tradedesk'],
      ['Hims & Hers', 'himsandhers'],
      ['ACME Co., Ltd.', 'acme'],
      ['Pine Cloud GmbH', 'pinecloud'],
      ['Harbor Foods S.A.', 'harborfoods'],
      ['Nørd Søft A/S', 'nørdsøft'.normalize('NFKD').replace(/[̀-ͯ]/g, '')],
      ['Crédit Agricole', 'creditagricole'],
      ['Pine Sp. z o.o.', 'pine'],
      ['Scale AI', 'scaleai'],
    ];
    for (const [name, key] of same) expect(v.normalizeName(name), name).toBe(key);
    // A legal form is only set aside at the end, and never the whole name.
    expect(v.normalizeName('Co')).toBe('co');
    expect(v.normalizeName('SE Ranking')).toBe('seranking');
    expect(v.normalizeName('...')).toBe('');
  });

  it('where the board states its company, that name decides: equal, or equal to a documented alias; anything else is a mismatch', () => {
    const c = candidate({ employer: 'Acme', aliases: ['Acme Robotics'] });
    expect(v.checkName(c, 'ACME, Inc.')).toEqual({ ok: true, nameCheck: 'stated_name' });
    expect(v.checkName(c, 'Acme Robotics Ltd')).toEqual({ ok: true, nameCheck: 'stated_name_alias' });
    expect(v.checkName(c, 'Acme Foods')).toEqual({ ok: false, reason: 'name_mismatch' });
    // The board id never rescues a stated name that differs.
    expect(v.checkName(candidate({ token: 'acme', employer: 'Acme' }), 'Other Corp')).toEqual({ ok: false, reason: 'name_mismatch' });
  });

  it('where it states none, the board id must be the employer\'s name, or a board id a document confirms for that employer', () => {
    const source = 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5';
    expect(v.checkName(candidate({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }), null)).toEqual({ ok: true, nameCheck: 'board_id_is_name' });
    expect(v.checkName(candidate({ ats: 'ashby', token: 'Pine-Cloud', employer: 'Pine Cloud, Inc.' }), null)).toEqual({ ok: true, nameCheck: 'board_id_is_name' });
    expect(v.checkName(candidate({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud' }), null)).toEqual({ ok: false, reason: 'name_unconfirmed' });
    expect(v.checkName(candidate({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], aliasSource: source }), null)).toEqual({ ok: true, nameCheck: 'board_id_alias', nameSource: source });
    expect(v.checkName(candidate({ ats: 'ashby', token: 'pine.com', employer: 'Pine', aliases: ['Pine.com'], aliasSource: source }), null)).toEqual({ ok: true, nameCheck: 'board_id_alias', nameSource: source });
    expect(v.checkName(candidate({ ats: 'ashby', token: 'pine', employer: 'Pine' }), '  ')).toEqual({ ok: true, nameCheck: 'board_id_is_name' });
  });

  it('an alias equal to the board id is the candidates file speaking, not the board: without a source it never gives the employer\'s name', () => {
    // Any board id can be written into its own line as an alias. That alone confirms nothing about the employer.
    expect(v.checkName(candidate({ ats: 'lever', token: 'anything-at-all', employer: 'Some Famous Company', aliases: ['anything-at-all'] }), null)).toEqual({ ok: true, nameCheck: 'board_id_only' });
    expect(v.checkName(candidate({ ats: 'ashby', token: 'pine.com', employer: 'Pine', aliases: ['Pine.com'] }), null)).toEqual({ ok: true, nameCheck: 'board_id_only' });
    // A source that is no document of this repository is no source.
    expect(v.checkName(candidate({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], aliasSource: 'I remember it' }), null)).toEqual({ ok: true, nameCheck: 'board_id_only' });
    // A source never rescues a board id the line does not list, nor a stated name that differs.
    expect(v.checkName(candidate({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-3'], aliasSource: 'docs/x.md 1' }), null)).toEqual({ ok: false, reason: 'name_unconfirmed' });
    expect(v.checkName(candidate({ token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], aliasSource: 'docs/x.md 1' }), 'Other Corp')).toEqual({ ok: false, reason: 'name_mismatch' });
  });
});

describe('Greenhouse', () => {
  it('valid: 200, postings, and the company name the answer states; countries come from the location line', async () => {
    const { result, net } = await check({}, { [GH('acme')]: { status: 200, body: { jobs: [gh('Berlin, Germany'), gh('Shanghai, China', 'Acme', 2), gh('Remote', 'Acme', 3), gh('Taipei', 'Acme', 4)], meta: { total: 4 } } } });
    expect(result).toEqual({
      ats: 'greenhouse',
      token: 'acme',
      employer: 'Acme',
      valid: true,
      nameCheck: 'stated_name',
      companyName: 'Acme',
      postings: 4,
      read: 4,
      complete: true,
      byCountry: { CN: 1, DE: 1, TW: 1 },
      unplaced: 1,
      mainland: 1,
      taiwan: 1,
      elsewhere: 2,
      requests: 1,
    });
    expect(net.calls.map((c) => c.url)).toEqual([GH('acme')]);
  });

  it('404: not found, asked exactly once', async () => {
    const { result, net } = await check({}, { [GH('acme')]: { status: 404, body: { status: 404, error: 'Job board not found' } } });
    expect(result).toMatchObject({ valid: false, reason: 'not_found' });
    expect(result).not.toHaveProperty('postings');
    expect(net.calls).toHaveLength(1);
  });

  it('a board of another company is a name mismatch; what it stated is reported, and it is not valid', async () => {
    const { result } = await check({ employer: 'Acme' }, { [GH('acme')]: { status: 200, body: { jobs: [gh('Berlin', 'Acme Hotels Group')] } } });
    expect(result).toMatchObject({ valid: false, reason: 'name_mismatch', companyName: 'Acme Hotels Group', postings: 1 });
  });

  it('zero postings is not valid; neither is an answer of another shape', async () => {
    expect((await check({}, { [GH('acme')]: { status: 200, body: { jobs: [], meta: { total: 0 } } } })).result).toMatchObject({ valid: false, reason: 'no_postings' });
    expect((await check({}, { [GH('acme')]: { status: 200, body: { error: 'x' } } })).result).toMatchObject({ valid: false, reason: 'unexpected_shape' });
    expect((await check({}, { [GH('acme')]: { status: 200, body: '<html>' } })).result).toMatchObject({ valid: false, reason: 'not_json' });
  });

  it('a network error is tried once more, then reported; a second try that answers is used', async () => {
    const down = await check({}, { [GH('acme')]: { status: 0, throws: true } });
    expect(down.result).toMatchObject({ valid: false, reason: 'network_error' });
    expect(down.net.calls).toHaveLength(2);
    expect(v.isFinal(down.result)).toBe(false);

    const back = await check({}, { [GH('acme')]: [{ status: 0, throws: true }, { status: 200, body: { jobs: [gh('Berlin')] } }] });
    expect(back.result).toMatchObject({ valid: true, postings: 1 });
    expect(back.net.calls).toHaveLength(2);
    // The retry waits its turn like any request to that host.
    expect(back.net.calls[1]!.startedAt - back.net.calls[0]!.endedAt).toBeGreaterThanOrEqual(300);
  });

  it('a request that never answers is cut at the time limit, tried once more, and reported as a timeout', async () => {
    const net = fakeFetch({});
    const hang = (_url: string, init: Init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    const client = v.createClient({ fetchImpl: hang, timeoutMs: 5000, agent: 'TestAgent/1.0' });
    const result = await drive(v.validateCandidate(candidate(), client, { pages: 1 }) as Promise<Record<string, unknown>>);
    expect(result).toMatchObject({ valid: false, reason: 'timeout' });
    expect(client.requests).toBe(2);
    expect(net.calls).toHaveLength(0);
  });
});

describe('Lever', () => {
  it('valid: the answer states no company, so the board id must be the name; pages are read to the end', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => leverPosting(`a${i}`, 'London', 'GB'));
    const page1 = [leverPosting('b1', 'Shenzhen', 'CN'), leverPosting('b2', 'Remote', null, ['Remote', 'Singapore', 'Taipei, Taiwan'])];
    const { result, net } = await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud', 0)]: { status: 200, body: page0 }, [LEVER('pinecloud', 1)]: { status: 200, body: page1 } });
    expect(result).toMatchObject({ valid: true, nameCheck: 'board_id_is_name', companyName: null, postings: 102, read: 102, complete: true, byCountry: { CN: 1, GB: 100, SG: 1, TW: 1 }, mainland: 1, taiwan: 1, elsewhere: 101, requests: 2 });
    expect(net.calls.map((c) => c.url)).toEqual([LEVER('pinecloud', 0), LEVER('pinecloud', 1)]);
  });

  it('a posting whose stated country is CN while its location names Hong Kong or Taipei is not counted for the mainland', async () => {
    const rows = [leverPosting('1', 'Shanghai', 'CN'), leverPosting('2', 'Hong Kong', 'CN'), leverPosting('3', 'Taipei', 'CN'), leverPosting('4', 'Remote', 'CN'), leverPosting('5', 'Shanghai', 'US')];
    const { result } = await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud')]: { status: 200, body: rows } });
    expect(result).toMatchObject({ valid: true, postings: 5, byCountry: { CN: 2, HK: 1 }, mainland: 2, taiwan: 0, unplaced: 2, elsewhere: 3 });
  });

  it('404, zero postings, a board id that is not the name, and a network error', async () => {
    expect((await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud')]: { status: 404, body: { ok: false, error: 'Document not found' } } })).result).toMatchObject({ valid: false, reason: 'not_found' });
    expect((await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud')]: { status: 200, body: [] } })).result).toMatchObject({ valid: false, reason: 'no_postings' });
    expect((await check({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud' }, { [LEVER('pine-2')]: { status: 200, body: [leverPosting('1', 'Paris', 'FR')] } })).result).toMatchObject({ valid: false, reason: 'name_unconfirmed', companyName: null, postings: 1 });
    const down = await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud')]: { status: 0, throws: true } });
    expect(down.result).toMatchObject({ valid: false, reason: 'network_error' });
    expect(down.net.calls).toHaveLength(2);
  });

  it('a board id listed for an employer: with the document that confirms it the result names the source; without one the board is valid as a board and nothing more', async () => {
    const routes = { [LEVER('pine-2')]: { status: 200, body: [leverPosting('1', 'Paris', 'FR')] } };
    const sourced = await check({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'], aliasSource: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5' }, routes);
    expect(sourced.result).toMatchObject({ valid: true, nameCheck: 'board_id_alias', nameSource: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5', companyName: null, postings: 1 });
    const bare = await check({ ats: 'lever', token: 'pine-2', employer: 'Pine Cloud', aliases: ['pine-2'] }, routes);
    expect(bare.result).toMatchObject({ valid: true, nameCheck: 'board_id_only', companyName: null, postings: 1 });
    expect(bare.result).not.toHaveProperty('nameSource');
  });

  it('a listing longer than --pages is counted as far as it was read and marked incomplete', async () => {
    const full = Array.from({ length: 100 }, (_, i) => leverPosting(`a${i}`, 'London', 'GB'));
    const { result, net } = await check({ ats: 'lever', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud', 0)]: { status: 200, body: full }, [LEVER('pinecloud', 1)]: { status: 200, body: full } }, { pages: 1 });
    expect(result).toMatchObject({ valid: true, postings: 100, complete: false, requests: 1 });
    expect(net.calls).toHaveLength(1);
  });

  it('lever_eu asks the EU host and nothing else', async () => {
    const { result, net } = await check({ ats: 'lever_eu', token: 'pinecloud', employer: 'Pine Cloud' }, { [LEVER('pinecloud', 0, 'api.eu.lever.co')]: { status: 200, body: [leverPosting('1', 'Paris', 'FR')] } });
    expect(result).toMatchObject({ ats: 'lever_eu', valid: true, byCountry: { FR: 1 } });
    expect(net.calls.map((c) => c.host)).toEqual(['api.eu.lever.co']);
  });
});

describe('Ashby', () => {
  it('valid: listed postings only; the country is the stated postal country, else the location line', async () => {
    const jobs = [
      ashbyJob('1', 'New York', 'United States'),
      ashbyJob('2', 'Hsinchu', null),
      ashbyJob('3', 'Remote', null, { secondaryLocations: [{ location: 'Shanghai, China' }, { location: 'x', address: { postalAddress: { addressCountry: 'Singapore' } } }] }),
      ashbyJob('4', 'Hidden', 'France', { isListed: false }),
    ];
    const { result, net } = await check({ ats: 'ashby', token: 'pinecloud', employer: 'Pine Cloud' }, { [ASHBY('pinecloud')]: { status: 200, body: { apiVersion: '1', jobs } } });
    expect(result).toMatchObject({ valid: true, nameCheck: 'board_id_is_name', postings: 3, byCountry: { CN: 1, SG: 1, TW: 1, US: 1 }, mainland: 1, taiwan: 1, elsewhere: 2, unplaced: 0, requests: 1 });
    expect(net.calls.map((c) => c.url)).toEqual([ASHBY('pinecloud')]);
  });

  it('404, zero postings, a board id that is not the name, and a network error', async () => {
    const c = { ats: 'ashby', token: 'pinecloud', employer: 'Pine Cloud' };
    expect((await check(c, { [ASHBY('pinecloud')]: { status: 404 } })).result).toMatchObject({ valid: false, reason: 'not_found' });
    expect((await check(c, { [ASHBY('pinecloud')]: { status: 200, body: { jobs: [ashbyJob('1', 'x', null, { isListed: false })] } } })).result).toMatchObject({ valid: false, reason: 'no_postings' });
    expect((await check({ ...c, employer: 'Pine' }, { [ASHBY('pinecloud')]: { status: 200, body: { jobs: [ashbyJob('1', 'Paris', 'France')] } } })).result).toMatchObject({ valid: false, reason: 'name_unconfirmed' });
    const down = await check(c, { [ASHBY('pinecloud')]: { status: 0, throws: true } });
    expect(down.result).toMatchObject({ valid: false, reason: 'network_error' });
    expect(down.net.calls).toHaveLength(2);
  });
});

describe('SmartRecruiters', () => {
  it('valid: the company name of the rows, the board\'s own total, the country field of each row', async () => {
    const rows = [srRow('1', 'de'), srRow('2', 'cn'), srRow('3', 'tw'), srRow('4', 'de')];
    const { result, net } = await check({ ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods' }, { [SR('HarborFoods')]: { status: 200, body: { offset: 0, limit: 100, totalFound: 4, content: rows } } });
    expect(result).toMatchObject({ valid: true, nameCheck: 'stated_name', companyName: 'Harbor Foods', postings: 4, read: 4, complete: true, byCountry: { CN: 1, DE: 2, TW: 1 }, mainland: 1, taiwan: 1, elsewhere: 2, requests: 1 });
    expect(net.calls.map((c) => c.url)).toEqual([SR('HarborFoods')]);
  });

  it('an id nobody has answers 200 with nothing: no postings, not valid; a 404 and a wrong company likewise', async () => {
    const c = { ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods' };
    expect((await check(c, { [SR('HarborFoods')]: { status: 200, body: { totalFound: 0, content: [] } } })).result).toMatchObject({ valid: false, reason: 'no_postings' });
    expect((await check(c, { [SR('HarborFoods')]: { status: 404 } })).result).toMatchObject({ valid: false, reason: 'not_found' });
    expect((await check(c, { [SR('HarborFoods')]: { status: 200, body: { totalFound: 1, content: [srRow('1', 'de', 'Harbor Freight')] } } })).result).toMatchObject({ valid: false, reason: 'name_mismatch', companyName: 'Harbor Freight' });
    const down = await check(c, { [SR('HarborFoods')]: { status: 0, throws: true } });
    expect(down.result).toMatchObject({ valid: false, reason: 'network_error' });
    expect(down.net.calls).toHaveLength(2);
  });

  it('a candidate that names countries is asked once per country with the API\'s own filter; the total of a pass is that country\'s count', async () => {
    const cn = Array.from({ length: 100 }, (_, i) => srRow(`c${i}`, 'cn'));
    const { result, net } = await check(
      { ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods', countries: ['CN', 'TW'] },
      { [SR('HarborFoods', 0, 'cn')]: { status: 200, body: { totalFound: 1322, content: cn } }, [SR('HarborFoods', 0, 'tw')]: { status: 200, body: { totalFound: 2, content: [srRow('t1', 'tw'), srRow('t2', 'tw')] } } },
      { pages: 1 },
    );
    expect(net.calls.map((c) => c.url)).toEqual([SR('HarborFoods', 0, 'cn'), SR('HarborFoods', 0, 'tw')]);
    expect(result).toMatchObject({ valid: true, countries: ['CN', 'TW'], postings: 1324, read: 102, complete: true, byCountry: { CN: 1322, TW: 2 }, mainland: 1322, taiwan: 2, elsewhere: 0, requests: 2 });
  });

  it('a filtered pass whose rows are not all in that country is not credited: the count is what was read, marked incomplete', async () => {
    const mixed = [...Array.from({ length: 99 }, (_, i) => srRow(`c${i}`, 'cn')), srRow('x', 'sg')];
    const { result } = await check({ ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods', countries: ['CN'] }, { [SR('HarborFoods', 0, 'cn')]: { status: 200, body: { totalFound: 500, content: mixed } } }, { pages: 1 });
    expect(result).toMatchObject({ valid: true, postings: 500, read: 100, complete: false, byCountry: { CN: 99, SG: 1 }, mainland: 99 });
  });

  it('a listing of several pages is read to its end when --pages reaches it', async () => {
    const page = (n: number, country: string, length = 100) => Array.from({ length }, (_, i) => srRow(`${n}-${i}`, country));
    const routes = {
      [SR('HarborFoods', 0)]: { status: 200, body: { totalFound: 250, content: page(0, 'de') } },
      [SR('HarborFoods', 1)]: { status: 200, body: { totalFound: 250, content: page(1, 'fr') } },
      [SR('HarborFoods', 2)]: { status: 200, body: { totalFound: 250, content: page(2, 'cn', 50) } },
    };
    const { result, net } = await check({ ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods' }, routes, { pages: 3 });
    expect(net.calls.map((c) => c.url)).toEqual([SR('HarborFoods', 0), SR('HarborFoods', 1), SR('HarborFoods', 2)]);
    expect(result).toMatchObject({ valid: true, postings: 250, read: 250, complete: true, byCountry: { CN: 50, DE: 100, FR: 100 }, mainland: 50, elsewhere: 200, requests: 3 });
  });

  it('a listing longer than --pages can reach is not paged at all: one request, the board\'s own total, the countries of the first page, marked incomplete', async () => {
    const first = Array.from({ length: 100 }, (_, i) => srRow(`a${i}`, 'de'));
    const { result, net } = await check({ ats: 'smartrecruiters', token: 'HarborFoods', employer: 'Harbor Foods' }, { [SR('HarborFoods', 0)]: { status: 200, body: { totalFound: 950, content: first } } }, { pages: 2 });
    expect(net.calls).toHaveLength(1);
    expect(result).toMatchObject({ valid: true, postings: 950, read: 100, complete: false, byCountry: { DE: 100 }, elsewhere: 100, requests: 1 });
  });
});

describe('politeness', () => {
  it('never more than 2 requests in flight per host, and at least 300 ms between one request to a host and the next', async () => {
    const tokens = Array.from({ length: 9 }, (_, i) => `acme${i}`);
    const routes: Record<string, Answer> = {};
    // Slow and fast answers mixed, so requests overlap and finish out of order.
    tokens.forEach((t, i) => (routes[GH(t)] = { status: 200, body: { jobs: [gh('Berlin', t)] }, latencyMs: [900, 20, 450, 20, 700, 20, 20, 1200, 20][i] }));
    tokens.forEach((t, i) => (routes[ASHBY(t)] = { status: 200, body: { jobs: [ashbyJob('1', 'Paris', 'France')] }, latencyMs: [20, 800, 20, 20, 600, 20, 900, 20, 20][i] }));
    const net = fakeFetch(routes);
    const client = v.createClient({ fetchImpl: net.fetch, agent: 'TestAgent/1.0' });
    const list = [...tokens.map((t) => candidate({ token: t, employer: t })), ...tokens.map((t) => candidate({ ats: 'ashby', token: t, employer: t }))];
    const t0 = Date.now();
    const results = (await drive(v.validateAll(list, client, { pages: 1 }))) as Array<Record<string, unknown>>;
    expect(results.every((r) => r.valid === true)).toBe(true);
    expect(results.map((r) => `${r.ats}:${r.token}`)).toEqual(list.map((c) => `${c.ats}:${c.token}`));
    expect(client.requests).toBe(18);

    for (const host of ['boards-api.greenhouse.io', 'api.ashbyhq.com']) {
      const calls = net.to(host);
      expect(calls).toHaveLength(9);
      expect(net.peak.get(host), host).toBe(2);
      // The pause, from every earlier start and every earlier end on that host.
      for (const call of calls) {
        for (const earlier of calls) {
          if (earlier === call || earlier.startedAt > call.startedAt) continue;
          if (earlier.startedAt < call.startedAt) expect(call.startedAt - earlier.startedAt, `${host} start to start`).toBeGreaterThanOrEqual(300);
          if (earlier.endedAt <= call.startedAt) expect(call.startedAt - earlier.endedAt, `${host} end to start`).toBeGreaterThanOrEqual(300);
        }
      }
    }
    // Hosts are worked side by side: the whole run takes about as long as one host, not the two added up.
    const perHost = ['boards-api.greenhouse.io', 'api.ashbyhq.com'].map((h) => Math.max(...net.to(h).map((c) => c.endedAt)) - t0);
    expect(Date.now() - t0).toBeLessThan(perHost[0]! + perHost[1]! - 1000);
  });

  it('the pause can be raised, and a value under 300 ms is raised to 300', async () => {
    for (const [pauseMs, floor] of [[1000, 1000], [10, 300]] as const) {
      const net = fakeFetch({}, { status: 404, latencyMs: 5 });
      const client = v.createClient({ fetchImpl: net.fetch, pauseMs, agent: 'TestAgent/1.0' });
      await drive(v.validateAll(['a', 'b', 'c'].map((t) => candidate({ token: t })), client, { pages: 1 }));
      const starts = net.calls.map((c) => c.startedAt);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(floor);
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(floor);
    }
  });

  it('--max is a hard cap: not one request more, and the candidates not reached are left open', async () => {
    const tokens = Array.from({ length: 12 }, (_, i) => `acme${i}`);
    const net = fakeFetch({}, { status: 404 });
    const client = v.createClient({ fetchImpl: net.fetch, max: 5, agent: 'TestAgent/1.0' });
    const results = (await drive(v.validateAll(tokens.map((t) => candidate({ token: t })), client, { pages: 1 }))) as Array<Record<string, unknown>>;
    expect(net.calls).toHaveLength(5);
    expect(client.requests).toBe(5);
    expect(results.filter((r) => r.reason === 'not_found')).toHaveLength(5);
    expect(results.filter((r) => r.reason === 'request_cap')).toHaveLength(7);
    expect(results.filter((r) => r.reason === 'request_cap').every((r) => !v.isFinal(r))).toBe(true);
  });

  it('a retry counts against the cap too', async () => {
    const net = fakeFetch({}, { status: 0, throws: true });
    const client = v.createClient({ fetchImpl: net.fetch, max: 3, agent: 'TestAgent/1.0' });
    const results = (await drive(v.validateAll(['a', 'b', 'c'].map((t) => candidate({ token: t })), client, { pages: 1 }))) as Array<Record<string, unknown>>;
    expect(net.calls).toHaveLength(3);
    expect(results.map((r) => r.reason).sort()).toEqual(['network_error', 'request_cap', 'request_cap']);
  });

  it('a host that answers 429 is left alone for the rest of the run; other hosts go on', async () => {
    const net = fakeFetch({ [GH('a')]: { status: 429 }, [ASHBY('pinecloud')]: { status: 200, body: { jobs: [ashbyJob('1', 'Paris', 'France')] } } }, { status: 404 });
    const client = v.createClient({ fetchImpl: net.fetch, inFlight: 1, agent: 'TestAgent/1.0' });
    const list = [candidate({ token: 'a' }), candidate({ token: 'b' }), candidate({ token: 'c' }), candidate({ ats: 'ashby', token: 'pinecloud', employer: 'Pine Cloud' })];
    const results = (await drive(v.validateAll(list, client, { pages: 1 }))) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ valid: false, reason: 'rate_limited' });
    expect(results.slice(1, 3).every((r) => r.reason === 'host_rate_limited' || r.reason === 'not_found')).toBe(true);
    expect(results.some((r) => r.reason === 'host_rate_limited')).toBe(true);
    expect(results[3]).toMatchObject({ valid: true });
    expect(client.limitedHosts()).toEqual(['boards-api.greenhouse.io']);
    // No request to the host after its 429 was read.
    const told = net.to('boards-api.greenhouse.io').find((c) => c.url === GH('a'))!.endedAt;
    expect(net.to('boards-api.greenhouse.io').filter((c) => c.startedAt > told)).toHaveLength(0);
    expect(results.filter((r) => r.reason === 'rate_limited' || r.reason === 'host_rate_limited').every((r) => !v.isFinal(r))).toBe(true);
  });

  it('every request says who is asking, asks for JSON, is a GET and does not follow a redirect', async () => {
    const net = fakeFetch({ [GH('acme')]: { status: 302 }, [ASHBY('pinecloud')]: { status: 200, body: { jobs: [ashbyJob('1', 'Paris', 'France')] } } });
    const client = v.createClient({ fetchImpl: net.fetch, agent: v.userAgent({ JOB_SOURCES_CONTACT: 'mailto:jobs@example.invalid' }) });
    const results = (await drive(v.validateAll([candidate(), candidate({ ats: 'ashby', token: 'pinecloud', employer: 'Pine Cloud' })], client, { pages: 1 }))) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ valid: false, reason: 'redirect' });
    expect(v.isFinal(results[0])).toBe(true);
    expect(net.calls).toHaveLength(2);
    for (const call of net.calls) {
      expect(call.init.method).toBe('GET');
      expect(call.init.redirect).toBe('manual');
      expect(call.init.headers).toEqual({ Accept: 'application/json', 'User-Agent': 'RoboApplyJobs/1.0 (+mailto:jobs@example.invalid)' });
      expect(Object.keys(call.init.headers!).some((h) => /key|auth|cookie/i.test(h))).toBe(false);
    }
  });

  it('the User-Agent names the site when no contact is set, uses only the first line of one, and never poses as a browser', () => {
    expect(v.userAgent({})).toBe('RoboApplyJobs/1.0 (+https://www.roboapply.io)');
    expect(v.userAgent({ JOB_SOURCES_CONTACT: ' \nmailto:a@example.invalid\r\nX-Injected: 1' })).toBe('RoboApplyJobs/1.0 (+mailto:a@example.invalid)');
    expect(v.userAgent({ JOB_SOURCES_CONTACT: 'jobs (team) é' })).toBe('RoboApplyJobs/1.0 (+jobs team)');
    expect(v.userAgent({ JOB_SOURCES_CONTACT: 'x'.repeat(500) }).length).toBe(200);
    expect(v.userAgent({})).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('only the five documented board APIs can be asked: any other host is refused before a request is made', async () => {
    expect(v.ALLOWED_HOSTS.slice().sort()).toEqual(['api.ashbyhq.com', 'api.eu.lever.co', 'api.lever.co', 'api.smartrecruiters.com', 'boards-api.greenhouse.io']);
    const net = fakeFetch({}, { status: 200, body: {} });
    const client = v.createClient({ fetchImpl: net.fetch, agent: 'TestAgent/1.0' });
    for (const url of [
      'https://www.linkedin.com/jobs/search',
      'https://www.indeed.com/jobs',
      'https://www.glassdoor.com/Job',
      'https://jsearch.p.rapidapi.com/search',
      'https://www.104.com.tw/jobs/search/',
      'https://www.zhipin.com/web/geek/job',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/jobs',
      'https://boards.greenhouse.io/acme',
      'http://boards-api.greenhouse.io/v1/boards/acme/jobs',
      'https://boards-api.greenhouse.io.example.invalid/v1/boards/acme/jobs',
      'not a url',
    ]) {
      await expect(client.getJson(url), url).rejects.toMatchObject({ reason: 'host_not_allowed' });
    }
    expect(net.calls).toHaveLength(0);
    expect(client.requests).toBe(0);
    expect(v.isFinal({ valid: false, reason: 'host_not_allowed' })).toBe(true);
  });
});

describe('the report', () => {
  const files = () => {
    const disk = new Map<string, string>();
    return {
      disk,
      deps: (net: ReturnType<typeof fakeFetch>, candidates: string) => ({
        readFile: (p: string) => {
          if (p === 'c.jsonl') return candidates;
          if (disk.has(p)) return disk.get(p)!;
          throw new Error(`no such file ${p}`);
        },
        exists: (p: string) => disk.has(p),
        writeFile: (p: string, data: string) => void disk.set(p, data),
        fetch: net.fetch,
        env: {},
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    };
  };
  const CANDIDATES = [
    '{"ats":"greenhouse","token":"acme","employer":"Acme"}',
    '{"ats":"greenhouse","token":"gone","employer":"Gone"}',
    '{"ats":"lever","token":"pinecloud","employer":"Pine Cloud"}',
    '{"ats":"ashby","token":"pinecloud","employer":"Pine Cloud"}',
    '{"ats":"smartrecruiters","token":"HarborFoods","employer":"Harbor Foods"}',
    '{"ats":"greenhouse","token":"other","employer":"Other"}',
  ].join('\n');
  const ROUTES = {
    [GH('acme')]: { status: 200, body: { jobs: [gh('Berlin, Germany'), gh('Shanghai', 'Acme', 2)] } },
    [GH('gone')]: { status: 404 },
    [GH('other')]: { status: 200, body: { jobs: [gh('Paris', 'Somebody Else')] } },
    [LEVER('pinecloud')]: { status: 200, body: [leverPosting('1', 'Taipei', 'TW')] },
    [ASHBY('pinecloud')]: { status: 200, body: { jobs: [ashbyJob('1', 'Tokyo', 'Japan')] } },
    [SR('HarborFoods')]: { status: 200, body: { totalFound: 1, content: [srRow('1', 'sg')] } },
  };
  const ARGS = ['--candidates', 'c.jsonl', '--date', '2026-10-11', '--out', 'r.json'];

  it('holds counts, countries, company names and the date given; no posting title, no posting text, no time of the clock', async () => {
    const net = fakeFetch(ROUTES);
    const f = files();
    const code = await drive(v.main(ARGS, f.deps(net, CANDIDATES)) as Promise<number>);
    expect(code).toBe(0);
    const written = f.disk.get('r.json')!;
    // Nothing of a posting but where it is.
    for (const secret of [POSTING_TITLE, POSTING_TEXT, 'SYNTHETIC-TITLE', 'SYNTHETIC-TEXT', 'Lighthouse', 'example.invalid/1']) expect(written).not.toContain(secret);
    // The date is the argument (the fake clock says 2031), and no instant is written anywhere.
    expect(written).not.toMatch(/2031|\d{2}:\d{2}:\d{2}|T\d{2}:/);
    const report = JSON.parse(written);
    expect(report).toMatchObject({ date: '2026-10-11', verifiedBy: 'live board API', userAgent: 'RoboApplyJobs/1.0 (+https://www.roboapply.io)', requests: 6, politeness: { inFlightPerHost: 2, pauseMs: 300, retriesAfterNetworkError: 1 } });
    expect(report.runs).toEqual([{ asked: 6, requests: 6, max: 800, pages: 10 }]);
    expect(report.results.map((r: { ats: string; token: string }) => `${r.ats}:${r.token}`)).toEqual(['greenhouse:acme', 'greenhouse:gone', 'lever:pinecloud', 'ashby:pinecloud', 'smartrecruiters:HarborFoods', 'greenhouse:other']);
    // Every key of every result is one of the facts the report may hold.
    const allowed = new Set(['ats', 'token', 'employer', 'countries', 'valid', 'reason', 'nameCheck', 'nameSource', 'companyName', 'postings', 'read', 'complete', 'byCountry', 'unplaced', 'mainland', 'taiwan', 'elsewhere', 'requests']);
    for (const r of report.results) for (const key of Object.keys(r)) expect(allowed.has(key), key).toBe(true);
    expect(report.results[0]).toMatchObject({ valid: true, companyName: 'Acme', postings: 2, byCountry: { CN: 1, DE: 1 } });
    expect(report.results[1]).toEqual({ ats: 'greenhouse', token: 'gone', employer: 'Gone', valid: false, reason: 'not_found' });
    expect(report.results[5]).toMatchObject({ valid: false, reason: 'name_mismatch', companyName: 'Somebody Else' });
    expect(report.summary.greenhouse).toEqual({ tried: 3, valid: 1, postings: 2, open: 0, reasons: { not_found: 1, name_mismatch: 1 } });
    expect(report.summary.all).toMatchObject({ tried: 6, valid: 4, postings: 5 });
  });

  it('a second run asks only what has no final answer: a 404 and a valid board are never asked again', async () => {
    const f = files();
    const first = fakeFetch({ ...ROUTES, [ASHBY('pinecloud')]: { status: 503 }, [SR('HarborFoods')]: { status: 0, throws: true } });
    expect(await drive(v.main(ARGS, f.deps(first, CANDIDATES)) as Promise<number>)).toBe(3);
    const afterFirst = JSON.parse(f.disk.get('r.json')!);
    expect(afterFirst.results.filter((r: { valid: boolean }) => !r.valid).map((r: { reason: string }) => r.reason).sort()).toEqual(['http_503', 'name_mismatch', 'network_error', 'not_found']);
    expect(afterFirst.summary.all.open).toBe(2);

    const second = fakeFetch(ROUTES);
    expect(await drive(v.main(ARGS, f.deps(second, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(second.calls.map((c) => c.url).sort()).toEqual([ASHBY('pinecloud'), SR('HarborFoods')].sort());
    const report = JSON.parse(f.disk.get('r.json')!);
    expect(report.requests).toBe(first.calls.length + 2);
    expect(report.runs).toHaveLength(2);
    expect(report.summary.all).toMatchObject({ tried: 6, valid: 4, open: 0 });

    // A third run has nothing to ask.
    const third = fakeFetch(ROUTES);
    expect(await drive(v.main(ARGS, f.deps(third, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(third.calls).toHaveLength(0);
  });

  it('--only asks one system; --max leaves the rest for the next run; a report of another date is refused', async () => {
    const f = files();
    const only = fakeFetch(ROUTES);
    expect(await drive(v.main([...ARGS, '--only', 'lever'], f.deps(only, CANDIDATES)) as Promise<number>)).toBe(3);
    expect(only.calls.map((c) => c.host)).toEqual(['api.lever.co']);

    const capped = fakeFetch(ROUTES);
    expect(await drive(v.main([...ARGS, '--max', '2'], f.deps(capped, CANDIDATES)) as Promise<number>)).toBe(3);
    expect(capped.calls).toHaveLength(2);

    const said: string[] = [];
    const other = fakeFetch(ROUTES);
    const code = await drive(v.main(['--candidates', 'c.jsonl', '--date', '2026-10-12', '--out', 'r.json'], { ...f.deps(other, CANDIDATES), stderr: (l: string) => said.push(l) }) as Promise<number>);
    expect(code).toBe(2);
    expect(said.join(' ')).toMatch(/report of 2026-10-11/);
    expect(other.calls).toHaveLength(0);
  });

  it('--redo-incomplete asks again a valid board whose listing was cut short, and no other', async () => {
    const f = files();
    const long = Array.from({ length: 100 }, (_, i) => srRow(`a${i}`, 'de'));
    const firstRoutes = { ...ROUTES, [SR('HarborFoods')]: { status: 200, body: { totalFound: 150, content: long } } };
    const first = fakeFetch(firstRoutes);
    expect(await drive(v.main([...ARGS, '--pages', '1'], f.deps(first, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(JSON.parse(f.disk.get('r.json')!).results[4]).toMatchObject({ valid: true, postings: 150, read: 100, complete: false });

    const again = fakeFetch({ ...firstRoutes, [SR('HarborFoods', 1)]: { status: 200, body: { totalFound: 150, content: Array.from({ length: 50 }, (_, i) => srRow(`b${i}`, 'tw')) } } });
    expect(await drive(v.main([...ARGS, '--pages', '5', '--redo-incomplete'], f.deps(again, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(again.calls.map((c) => c.url)).toEqual([SR('HarborFoods', 0), SR('HarborFoods', 1)]);
    expect(JSON.parse(f.disk.get('r.json')!).results[4]).toMatchObject({ valid: true, postings: 150, read: 150, complete: true, byCountry: { DE: 100, TW: 50 } });
  });

  it('--redo asks the named candidates again, whatever the report holds, and refuses a key the file does not have', async () => {
    const f = files();
    expect(await drive(v.main(ARGS, f.deps(fakeFetch(ROUTES), CANDIDATES)) as Promise<number>)).toBe(0);
    const again = fakeFetch({ ...ROUTES, [GH('acme')]: { status: 200, body: { jobs: [gh('Berlin, Germany')] } } });
    expect(await drive(v.main([...ARGS, '--redo', 'greenhouse:acme,greenhouse:gone'], f.deps(again, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(again.calls.map((c) => c.url).sort()).toEqual([GH('acme'), GH('gone')]);
    expect(JSON.parse(f.disk.get('r.json')!).results[0]).toMatchObject({ token: 'acme', valid: true, postings: 1, byCountry: { DE: 1 }, mainland: 0 });
    const none = fakeFetch(ROUTES);
    expect(await drive(v.main([...ARGS, '--redo', 'greenhouse:nobody'], f.deps(none, CANDIDATES)) as Promise<number>)).toBe(2);
    expect(none.calls).toHaveLength(0);
  });

  it('asking a board again never loses what it answered: a failure in passing leaves the earlier answer standing, and says so', async () => {
    const f = files();
    expect(await drive(v.main(ARGS, f.deps(fakeFetch(ROUTES), CANDIDATES)) as Promise<number>)).toBe(0);
    const said: string[] = [];
    const down = fakeFetch({ ...ROUTES, [GH('acme')]: { status: 0, throws: true } });
    expect(await drive(v.main([...ARGS, '--redo', 'greenhouse:acme'], { ...f.deps(down, CANDIDATES), stdout: (l: string) => said.push(l) }) as Promise<number>)).toBe(0);
    expect(down.calls).toHaveLength(2);
    expect(JSON.parse(f.disk.get('r.json')!).results[0]).toMatchObject({ token: 'acme', valid: true, postings: 2 });
    expect(said.join('\n')).toMatch(/1 candidate\(s\) could not be asked again[^\n]*greenhouse:acme/);
    // A final answer does replace it: the board is gone now.
    const gone = fakeFetch({ ...ROUTES, [GH('acme')]: { status: 404 } });
    expect(await drive(v.main([...ARGS, '--redo', 'greenhouse:acme'], f.deps(gone, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(JSON.parse(f.disk.get('r.json')!).results[0]).toEqual({ ats: 'greenhouse', token: 'acme', employer: 'Acme', valid: false, reason: 'not_found' });
  });

  it('--rejudge asks nothing: an alias added to the candidates file makes a board that stated another name valid, and removing it takes that back', async () => {
    const f = files();
    const net = fakeFetch(ROUTES);
    expect(await drive(v.main(ARGS, f.deps(net, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(JSON.parse(f.disk.get('r.json')!).results[5]).toMatchObject({ token: 'other', valid: false, reason: 'name_mismatch', companyName: 'Somebody Else' });

    const withAlias = CANDIDATES.replace('"employer":"Other"}', '"employer":"Other","aliases":["Somebody Else"]}');
    const silent = fakeFetch(ROUTES);
    const said: string[] = [];
    expect(await drive(v.main([...ARGS, '--rejudge'], { ...f.deps(silent, withAlias), stdout: (l: string) => said.push(l) }) as Promise<number>)).toBe(0);
    expect(silent.calls).toHaveLength(0);
    expect(said.join(' ')).toMatch(/Asked nothing\. 1 answer/);
    const report = JSON.parse(f.disk.get('r.json')!);
    expect(report.results[5]).toMatchObject({ token: 'other', valid: true, nameCheck: 'stated_name_alias', companyName: 'Somebody Else', postings: 1 });
    expect(report.results[5]).not.toHaveProperty('reason');
    expect(report.summary.greenhouse).toMatchObject({ tried: 3, valid: 2 });
    expect(report.requests).toBe(6);
    // A 404 stays a 404 whatever the file says.
    expect(report.results[1]).toMatchObject({ token: 'gone', valid: false, reason: 'not_found' });

    expect(await drive(v.main([...ARGS, '--rejudge'], f.deps(silent, CANDIDATES)) as Promise<number>)).toBe(0);
    expect(JSON.parse(f.disk.get('r.json')!).results[5]).toMatchObject({ valid: false, reason: 'name_mismatch' });
    expect(silent.calls).toHaveLength(0);
    // Without a report there is nothing to judge again.
    expect(await drive(v.main(['--candidates', 'c.jsonl', '--date', '2026-10-11', '--out', 'none.json', '--rejudge'], f.deps(silent, CANDIDATES)) as Promise<number>)).toBe(2);
  });

  it('--rejudge applies a source added for a board id, and takes the employer\'s name back when the source is removed; nothing is asked', async () => {
    const f = files();
    const lines = (lever: string) => ['{"ats":"greenhouse","token":"acme","employer":"Acme"}', lever].join('\n');
    const bare = '{"ats":"lever","token":"pinecloud","employer":"Pine Cloud Holdings","aliases":["pinecloud"]}';
    const sourced = bare.replace('}', ',"aliasSource":"docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5"}');
    expect(await drive(v.main(ARGS, f.deps(fakeFetch(ROUTES), lines(bare))) as Promise<number>)).toBe(0);
    expect(JSON.parse(f.disk.get('r.json')!).results[1]).toMatchObject({ token: 'pinecloud', valid: true, nameCheck: 'board_id_only', employer: 'Pine Cloud Holdings' });

    const silent = fakeFetch(ROUTES);
    const said: string[] = [];
    expect(await drive(v.main([...ARGS, '--rejudge'], { ...f.deps(silent, lines(sourced)), stdout: (l: string) => said.push(l) }) as Promise<number>)).toBe(0);
    expect(said.join(' ')).toMatch(/Asked nothing\. 1 answer/);
    expect(JSON.parse(f.disk.get('r.json')!).results[1]).toMatchObject({ valid: true, nameCheck: 'board_id_alias', nameSource: 'docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5', postings: 1 });

    expect(await drive(v.main([...ARGS, '--rejudge'], f.deps(silent, lines(bare))) as Promise<number>)).toBe(0);
    const back = JSON.parse(f.disk.get('r.json')!).results[1];
    expect(back).toMatchObject({ valid: true, nameCheck: 'board_id_only', postings: 1 });
    expect(back).not.toHaveProperty('nameSource');
    expect(silent.calls).toHaveLength(0);
  });

  it('isFinal: a valid board, a 404, an empty board, a wrong name and a refusal are final; a cap, a timeout, a 429 and a 5xx are not', () => {
    for (const reason of ['not_found', 'no_postings', 'name_mismatch', 'name_unconfirmed', 'unexpected_shape', 'not_json', 'redirect', 'response_too_large', 'http_403', 'http_410']) expect(v.isFinal({ valid: false, reason }), reason).toBe(true);
    for (const reason of ['request_cap', 'network_error', 'timeout', 'rate_limited', 'host_rate_limited', 'http_500', 'http_503', 'http_408', 'internal_error']) expect(v.isFinal({ valid: false, reason }), reason).toBe(false);
    expect(v.isFinal({ valid: true })).toBe(true);
    expect(v.isFinal(undefined)).toBe(false);
  });
});

describe('where a posting is (location fields only)', () => {
  it('reads one location line as one place; Hong Kong, Macao and Taiwan are never mainland', () => {
    const cases: Array<[string, string | null]> = [
      ['Shanghai', 'CN'],
      ['Shenzhen, Guangdong, China', 'CN'],
      ['Remote - China', 'CN'],
      ['上海', 'CN'],
      ['Hong Kong, China', 'HK'],
      ['Macau', 'MO'],
      ['Taipei, Taiwan', 'TW'],
      ['Hsinchu', 'TW'],
      ['台北', 'TW'],
      ['Guangdong', null],
      ['Greater China', null],
      ['Shanghai or Singapore', null],
      // A country the line says in words decides over a city of another country; never mainland.
      ['Singapore; Shanghai', 'SG'],
      ['Remote', null],
      ['APAC', null],
      ['San Francisco, CA', 'US'],
      ['Toronto, CA', 'CA'],
      ['Berlin, DE', 'DE'],
      ['Bengaluru, IN', 'IN'],
      ['Perth, WA', 'AU'],
      ['Paris, TX', 'US'],
      // The server's city table knows Canton as an old name of Guangzhou; a US address is not in China.
      ['110 Albany Turnpike, Canton, CT 06019', 'US'],
      ['Canton, MA', 'US'],
      ['Canton, Michigan, United States', 'US'],
      ['Toronto, ON M5V 2T6', 'CA'],
      ['Guangzhou', 'CN'],
      ['Taiwan (Remote)', 'TW'],
      ['China (CN)', 'CN'],
      ['Lebanon, NH', 'US'],
      ['London, UK', 'GB'],
      ['Georgia', null],
      ['Remote (US)', 'US'],
      // Mainland China and Taiwan only when every part of the line is understood and agrees.
      ['Shanghai, Taipei', null],
      ['Shanghai / Singapore', 'SG'],
      ['Shanghai / Tokyo', null],
      ['China, APAC', null],
      ['Shanghai, Jiangsu', null],
      ['Suzhou, Jiangsu, China', 'CN'],
      ['Shanghai-CN', null],
      ['Shanghai or Beijing', null],
      ['Shanghai Office', null],
      ['Taipei, Taiwan, China', null],
      ['Hybrid - Shanghai', 'CN'],
      // The server reads a line from its end: what it does not know before the place is skipped, after it is not.
      ['Home based - Asia Pacific, Taipei', 'TW'],
      ['Kunshan, China', 'CN'],
      ['APAC - China', 'CN'],
      ['Greater Shanghai Area, Taipei', null],
      ['Tokyo-Shanghai, China', null],
      ['China, Guangdong, Shenzhen', null],
      ['Shenzhen, Guangdong, China', 'CN'],
      ['Taipei, HQ', null],
      // A two-letter label that opens the line never decides (a board that writes CH for China).
      ['CH - Shanghai, China', 'CN'],
      ['JP - Taipei, Taiwan', 'TW'],
      ['CH - Zurich, Switzerland', 'CH'],
      ['Shanghai, CH', 'CH'],
      ['HK - China', 'HK'],
      ['Zhubei, Hsinchu County, Taiwan', 'TW'],
    ];
    for (const [line, country] of cases) expect(places.countryOfLocation(line), line).toBe(country);
  });

  it('without the server\'s city table no mainland or Taiwan city is known: a board is never routed there on this file\'s own word', () => {
    const bare = places.buildCityIndex(null);
    expect(places.countryOfLocation('Shanghai', bare)).toBeNull();
    expect(places.countryOfLocation('Taipei', bare)).toBeNull();
    expect(places.countryOfLocation('Hong Kong', bare)).toBe('HK'); // a country name, not a city
    expect(places.countryOfLocation('China', bare)).toBe('CN'); // the line says the country
    expect(places.countryOfLocation('Shanghai, China', bare)).toBe('CN'); // an unknown town before the country, as on the server
    expect(places.countryOfLocation('Munich', bare)).toBeNull();
    expect(places.countryOfLocation('Leipzig', bare)).toBe('DE');
    expect(places.gazetteerInfo()).toMatchObject({ serverTable: true });
  });

  it('a country the board states for a posting: mainland China and Taiwan only when the stated country and the line do not disagree', () => {
    const cases: Array<[string, string | null, string | null]> = [
      ['Shanghai', 'CN', 'CN'],
      ['Remote', 'CN', 'CN'],
      ['Greater China', 'CN', 'CN'],
      ['SYNTHETIC Unknown Town', 'CN', 'CN'],
      ['', 'CN', 'CN'],
      ['Hong Kong', 'CN', 'HK'],
      ['Macau', 'CN', 'MO'],
      ['Singapore', 'CN', 'SG'],
      ['Taipei', 'CN', null],
      ['Tokyo, Japan; Taipei, Taiwan', 'CN', null],
      ['Taipei', 'TW', 'TW'],
      ['APAC', 'TW', 'TW'],
      ['Shanghai', 'TW', null],
      ['Shanghai', 'US', null],
      ['Hsinchu', 'US', null],
      ['London', 'US', 'GB'],
      ['SYNTHETIC Unknown Town', 'DE', 'DE'],
      ['Shanghai', null, 'CN'],
      ['Remote', null, null],
    ];
    for (const [line, stated, country] of cases) expect(places.countryOfStatedLocation(line, stated), `${line} / ${stated}`).toBe(country);
  });

  it('countryFromField accepts an ISO code in either case or a country name, and nothing else', () => {
    expect(places.countryFromField('cn')).toBe('CN');
    expect(places.countryFromField('TW')).toBe('TW');
    expect(places.countryFromField('uk')).toBe('GB');
    expect(places.countryFromField('United States')).toBe('US');
    expect(places.countryFromField('Taiwan, Province of China')).toBe('TW');
    expect(places.countryFromField('zz')).toBeNull();
    expect(places.countryFromField('Shanghai')).toBeNull();
    expect(places.countryFromField(null)).toBeNull();
  });

  it('tally: a posting counts once for each country it is located in; "elsewhere" is everything the international site would list', () => {
    const m = { places: [new Set(['CN']), new Set(['CN', 'SG']), new Set(['TW']), new Set(), new Set(['US'])], credited: { CN: 10, DE: 3 } };
    expect(v.tally(m)).toEqual({ byCountry: { CN: 12, DE: 3, SG: 1, TW: 1, US: 1 }, unplaced: 1, mainland: 12, taiwan: 1, elsewhere: 6 });
  });
});
