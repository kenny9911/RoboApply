// @vitest-environment node
//
// MKT-5F (JT-6, JT-7): the Taiwan routes over HTTP, with fake auth, a fake of
// the one AppConfig row and a recording audit writer. The server is the local
// route harness; nothing reaches a real database or the network.
import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeAuth, startRouteHarness, type HarnessUser, type RouteHarness } from '../../test/routeHarness.js';
import { FEATURE_MOUNTS } from '../index.js';
import { TW_COUNTIES, TW_DISTRICTS, TW_DISTRICTS_SOURCE, twPlaceKey } from '../jobs/geo/index.js';
import type { TwDistrictsResponse, TwPayRuleAdminView, TwPayRuleView } from './contract.js';
import { twDistrictsResponse } from './districts.js';
import { TW_PAY_RULE_CALLER_MAX_AGE_S, TW_PAY_RULE_DEFAULT, TW_PAY_RULE_HOLD_MS, TW_PAY_RULE_MAX_STALE_MS, createTwPayRuleHold } from './payRule.js';
import { fakeAppConfig } from './testkit.js';
import { TW_DISTRICTS_CACHE_CONTROL, TW_PAY_RULE_AUDIT_EVENT, TW_PAY_RULE_CACHE_CONTROL, createTwAdminRouter, createTwRouter, type TwAudit } from './routes.js';

const NOW = new Date('2026-10-12T03:00:00.000Z');
const P = '/api/v1/roboapply/tw';
const A = '/api/v1/roboapply/admin/tw';
const ROBO = 'localhost:3621';
const GO = 'goapply.localhost:3621';

interface Ok<T> {
  success: true;
  data: T;
}
interface Fail {
  success: false;
  code: string;
  error: string;
  details?: { issues?: Array<{ path: string[]; message: string }> };
}

const ENTRY = { thresholdTwd: 50_000, lawLabel: '就業服務法第5條第2項第6款', sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5', asOf: '2026-10-12' };

let harness: RouteHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function start(options: { rows?: Parameters<typeof fakeAppConfig>[0]; user?: HarnessUser | null; audit?: TwAudit; now?: () => Date } = {}) {
  const config = fakeAppConfig(options.rows);
  const now = options.now ?? (() => NOW);
  // One process: the public and the admin router share one hold of the rule, as they do in production (a fresh one per test).
  const payRuleHold = createTwPayRuleHold();
  const audited: Array<Parameters<TwAudit['write']>[0]> = [];
  const audit: TwAudit = options.audit ?? { write: async (input) => void audited.push(input) };
  const user = options.user === undefined ? { id: 'admin_1', role: 'admin' } : options.user;
  // The admin chain the way production builds it: an authenticated user, then the role check.
  const adminOnly: RequestHandler = (req, res, next) => {
    if ((req as unknown as { user?: HarnessUser }).user?.role !== 'admin') {
      res.status(403).json({ success: false, code: 'ADMIN_REQUIRED', error: 'Admin access required' });
      return;
    }
    next();
  };
  const adminAuth = [fakeAuth(() => user), adminOnly];
  harness = await startRouteHarness({
    mounts: [
      [P, createTwRouter({ db: config.db, now, payRuleHold })],
      [A, createTwAdminRouter({ db: config.db, now, audit, adminAuth, payRuleHold })],
    ],
  });
  return { h: harness, config, audited };
}

describe('GET /tw/pay-rule', () => {
  it('ACCEPT: with no row it answers NT$40,000, the law link and 2026-10-11, with no session; an edit reaches the note within 5 minutes', async () => {
    const { h } = await start();
    const res = await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ...TW_PAY_RULE_DEFAULT, isDefault: true } });
    expect(res.body.data).toMatchObject({ thresholdTwd: 40000, sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5', asOf: '2026-10-11' });
    // The 5 minutes are one minute in the process and four at the caller: this header (the web client's stale time is held to the same sum in twExtras.test.tsx).
    expect(res.headers.get('cache-control')).toBe('public, max-age=240');
    expect(TW_PAY_RULE_CACHE_CONTROL).toBe('public, max-age=240');
    expect(TW_PAY_RULE_MAX_STALE_MS).toBe(5 * 60_000);
    expect(TW_PAY_RULE_HOLD_MS + TW_PAY_RULE_CALLER_MAX_AGE_S * 1000).toBe(TW_PAY_RULE_MAX_STALE_MS);
  });

  it('review finding: the open route reads the row once a minute in a process, however many requests arrive, and again after the minute', async () => {
    let at = NOW.getTime();
    const { h, config } = await start({ now: () => new Date(at) });
    const reads = () => config.calls.filter((c) => c.op === 'findUnique').length;
    const answers = await Promise.all(Array.from({ length: 25 }, () => h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO })));
    expect(answers.map((r) => r.status)).toEqual(Array(25).fill(200));
    expect(new Set(answers.map((r) => r.body.data.thresholdTwd))).toEqual(new Set([40000]));
    expect(reads()).toBe(1);
    // 59 seconds later: still the held read.
    at += TW_PAY_RULE_HOLD_MS - 1000;
    await h.request('GET', `${P}/pay-rule`, { host: ROBO });
    expect(reads()).toBe(1);
    // After the minute: one new read, and the header is the same.
    at += 1000;
    const later = await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO });
    expect(reads()).toBe(2);
    expect(later.headers.get('cache-control')).toBe('public, max-age=240');
  });

  it('review finding: a rule stored by another process is answered here within the minute, never later; a save on this process is answered at once', async () => {
    let at = NOW.getTime();
    const { h, config } = await start({ now: () => new Date(at) });
    const amount = async () => (await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO })).body.data.thresholdTwd;
    expect(await amount()).toBe(40000);
    // Another process stores the rule: this one cannot know, and answers what it holds until the minute is over.
    config.rows.set('tw.payRule.v1', { value: JSON.stringify({ ...ENTRY, updatedAt: NOW.toISOString(), updatedBy: 'admin_2' }), updatedBy: 'admin_2' });
    at += 30_000;
    expect(await amount()).toBe(40000);
    at += TW_PAY_RULE_HOLD_MS - 30_000;
    expect(await amount()).toBe(50000);
    // A save through this process's admin route clears the hold: the very next answer is the new rule.
    const put = await h.request<Ok<TwPayRuleAdminView>>('PUT', `${A}/pay-rule`, { host: ROBO, body: { ...ENTRY, thresholdTwd: 60_000 } });
    expect(put.status).toBe(200);
    expect(await amount()).toBe(60000);
    // A refused save clears nothing and changes nothing.
    const before = config.calls.length;
    expect((await h.request<Fail>('PUT', `${A}/pay-rule`, { host: ROBO, body: { ...ENTRY, thresholdTwd: 45_500 } })).status).toBe(422);
    expect(await amount()).toBe(60000);
    // The refused save read the row for its own check; the public answer after it came from the hold.
    expect(config.calls.slice(before).filter((c) => c.op === 'upsert')).toEqual([]);
  });

  it('review finding: a read that fails is not held: the next request reads again', async () => {
    const { h, config } = await start();
    const real = config.db.appConfig.findUnique.bind(config.db.appConfig) as (args: unknown) => Promise<unknown>;
    let failing = true;
    (config.db.appConfig as unknown as { findUnique: (args: unknown) => Promise<unknown> }).findUnique = async (args: unknown) => {
      if (failing) throw new Error('database is away');
      return real(args);
    };
    expect((await h.request<Fail>('GET', `${P}/pay-rule`, { host: ROBO })).status).toBe(500);
    failing = false;
    const res = await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO });
    expect(res.status).toBe(200);
    expect(res.body.data.thresholdTwd).toBe(40000);
  });

  it('ACCEPT: changing the config value to 50,000 with a new as-of date changes the next answer, with no deploy', async () => {
    const { h } = await start();
    expect((await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO })).body.data.thresholdTwd).toBe(40000);
    const put = await h.request<Ok<TwPayRuleAdminView>>('PUT', `${A}/pay-rule`, { host: ROBO, body: ENTRY });
    expect(put.status).toBe(200);
    const next = await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO });
    expect(next.body.data).toEqual({ ...ENTRY, isDefault: false });
  });

  it('a stored value that cannot be read as a rule answers null: the note then shows no amount', async () => {
    const { h } = await start({ rows: { 'tw.payRule.v1': { value: '{"thresholdTwd":45500}' } } });
    const res = await h.request<Ok<TwPayRuleView | null>>('GET', `${P}/pay-rule`, { host: ROBO });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });
  });

  it('ACCEPT: answers 404 feature_disabled on GoApply', async () => {
    const { h, config } = await start();
    const res = await h.request<Fail>('GET', `${P}/pay-rule`, { host: GO });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'feature_disabled' });
    expect(config.calls).toEqual([]);
  });
});

describe('PUT /admin/tw/pay-rule', () => {
  it('stores the entry, answers the admin view and writes one audit row with who, from what and to what', async () => {
    const { h, config, audited } = await start();
    const res = await h.request<Ok<TwPayRuleAdminView>>('PUT', `${A}/pay-rule`, { host: ROBO, body: ENTRY });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rule: { ...ENTRY, isDefault: false }, stored: 'config', updatedAt: NOW.toISOString(), updatedBy: 'admin_1', default: { thresholdTwd: 40000 } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(config.rows.get('tw.payRule.v1')!.value)).toMatchObject({ thresholdTwd: 50000, asOf: '2026-10-12', updatedBy: 'admin_1' });
    expect(audited).toEqual([
      {
        adminId: 'admin_1',
        subjectUserId: null,
        eventType: 'admin_tw_pay_rule_updated',
        payload: { key: 'tw.payRule.v1', from: { thresholdTwd: 40000, asOf: '2026-10-11', stored: 'default' }, to: ENTRY },
      },
    ]);
    expect(TW_PAY_RULE_AUDIT_EVENT).toBe('admin_tw_pay_rule_updated');
    // The admin read shows the same.
    const get = await h.request<Ok<TwPayRuleAdminView>>('GET', `${A}/pay-rule`, { host: ROBO });
    expect(get.body.data).toMatchObject({ rule: { thresholdTwd: 50000 }, stored: 'config', updatedBy: 'admin_1' });
  });

  it.each([
    ['a threshold that is not a whole number of thousands', { ...ENTRY, thresholdTwd: 45_500 }, ['thresholdTwd']],
    ['an http link', { ...ENTRY, sourceUrl: 'http://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5' }, ['sourceUrl']],
    ['a future date', { ...ENTRY, asOf: '2026-10-13' }, ['asOf']],
    ['a day that does not exist', { ...ENTRY, asOf: '2026-02-30' }, ['asOf']],
    ['all three at once', { ...ENTRY, thresholdTwd: 45_500, sourceUrl: 'http://x.test', asOf: '2030-01-01' }, ['thresholdTwd', 'sourceUrl', 'asOf']],
  ])('ACCEPT: %s is refused with 422 and one issue per field; nothing is stored and nothing is audited', async (_label, body, paths) => {
    const { h, config, audited } = await start();
    const res = await h.request<Fail>('PUT', `${A}/pay-rule`, { host: ROBO, body });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.details?.issues?.map((i) => i.path[0])).toEqual(paths);
    expect(config.rows.size).toBe(0);
    expect(audited).toEqual([]);
    // The public answer is still the default.
    expect((await h.request<Ok<TwPayRuleView>>('GET', `${P}/pay-rule`, { host: ROBO })).body.data.thresholdTwd).toBe(40000);
  });

  it.each([
    ['a missing field', { thresholdTwd: 50_000, lawLabel: 'x', sourceUrl: 'https://x.test' }],
    ['an unknown field', { ...ENTRY, isDefault: true }],
    ['a threshold sent as text', { ...ENTRY, thresholdTwd: '50000' }],
    ['no body', undefined],
  ])('a malformed body (%s) is a 422 too', async (_label, body) => {
    const { h, config } = await start();
    const res = await h.request<Fail>('PUT', `${A}/pay-rule`, { host: ROBO, body });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_request');
    expect(config.rows.size).toBe(0);
  });

  it('needs an admin: no session is 401, a signed-in seeker is 403, and neither reads or writes anything', async () => {
    const anonymous = await start({ user: null });
    for (const [method, body] of [['GET', undefined], ['PUT', ENTRY]] as const) {
      const res = await anonymous.h.request<Fail>(method, `${A}/pay-rule`, { host: ROBO, body });
      expect(res.status, method).toBe(401);
    }
    expect(anonymous.config.calls).toEqual([]);
    await anonymous.h.close();
    const seeker = await start({ user: { id: 'user_1', role: 'seeker' } });
    for (const [method, body] of [['GET', undefined], ['PUT', ENTRY]] as const) {
      const res = await seeker.h.request<Fail>(method, `${A}/pay-rule`, { host: ROBO, body });
      expect(res.status, method).toBe(403);
    }
    expect(seeker.config.calls).toEqual([]);
    expect(seeker.audited).toEqual([]);
  });

  it('ACCEPT: answers 404 feature_disabled on GoApply, for an admin too, and stores nothing', async () => {
    const { h, config, audited } = await start();
    for (const [method, body] of [['GET', undefined], ['PUT', ENTRY]] as const) {
      const res = await h.request<Fail>(method, `${A}/pay-rule`, { host: GO, body });
      expect(res.status, method).toBe(404);
      expect(res.body.code, method).toBe('feature_disabled');
    }
    expect(config.calls).toEqual([]);
    expect(audited).toEqual([]);
  });

  it('an audit writer that fails does not undo the save', async () => {
    const { h, config } = await start({ audit: { write: async () => Promise.reject(new Error('audit store down')) } });
    const res = await h.request<Ok<TwPayRuleAdminView>>('PUT', `${A}/pay-rule`, { host: ROBO, body: ENTRY });
    expect(res.status).toBe(200);
    expect(JSON.parse(config.rows.get('tw.payRule.v1')!.value).thresholdTwd).toBe(50000);
  });
});

describe('GET /tw/districts', () => {
  it('ACCEPT: lists the 22 counties, each with its districts, with no session, cached for a day', async () => {
    const { h } = await start();
    const res = await h.request<Ok<TwDistrictsResponse>>('GET', `${P}/districts`, { host: ROBO });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(TW_DISTRICTS_CACHE_CONTROL);
    const { counties, source, asOf } = res.body.data;
    expect(counties).toHaveLength(22);
    expect(counties.map((c) => c.name)).toEqual(TW_COUNTIES.map((c) => c.name));
    expect(counties.map((c) => c.code)).toEqual(TW_COUNTIES.map((c) => c.code));
    // Where the names come from, and when (D3), with the credit line the open-data licence asks for.
    expect(source).toMatchObject({ publisher: expect.any(String), url: expect.stringMatching(/^https:\/\//), license: expect.any(String), retrievedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(source).toEqual({
      name: '縣市鄉鎮中英對照檔',
      publisher: '中華郵政股份有限公司',
      url: 'https://data.gov.tw/dataset/5949',
      license: '政府資料開放授權條款-第1版',
      licenseUrl: 'https://data.gov.tw/license',
      retrievedOn: TW_DISTRICTS_SOURCE.retrievedOn,
      attribution: TW_DISTRICTS_SOURCE.attribution,
    });
    expect(source.attribution).toContain('中華郵政股份有限公司');
    expect(source.attribution).toContain('「縣市鄉鎮中英對照檔」');
    expect(source.attribution).toContain('政府資料開放授權條款第1版');
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('every district of the table is there once, under its county, with the value the filter stores', () => {
    const { counties } = twDistrictsResponse();
    const names = TW_DISTRICTS.flatMap((d) => (d.districts?.length ? d.districts : [d.district]).map((name) => `${d.county}${name}`));
    const listed = counties.flatMap((c) => c.districts.map((d) => d.value));
    expect(listed.sort()).toEqual(names.sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const county of counties) for (const d of county.districts) expect(d.value).toBe(`${county.name}${d.name}`);
    const hsinchuCounty = counties.find((c) => c.name === '新竹縣')!;
    expect(hsinchuCounty.districts.find((d) => d.name === '竹北市')).toEqual({ name: '竹北市', value: '新竹縣竹北市', zip3: '302', en: expect.any(String) });
    // Districts that share one postal code are separate entries (新竹市 300).
    expect(counties.find((c) => c.name === '新竹市')!.districts.map((d) => d.name)).toEqual(['東區', '北區', '香山區']);
    // The same name in two counties is two entries with two values.
    expect(counties.find((c) => c.name === '台北市')!.districts.some((d) => d.value === '台北市信義區')).toBe(true);
    expect(counties.find((c) => c.name === '基隆市')!.districts.some((d) => d.value === '基隆市信義區')).toBe(true);
  });

  it('each county carries the folded names a typed place can match, and no county answers to another county\'s name', () => {
    const { counties } = twDistrictsResponse();
    const taipei = counties.find((c) => c.code === '01')!;
    expect(taipei).toMatchObject({ name: '台北市', nameAlt: '臺北市' });
    for (const typed of ['台北市', '臺北市', 'Taipei', 'taipei city', '台北']) expect(taipei.keys, typed).toContain(twPlaceKey(typed));
    for (const county of counties) {
      expect(county.keys).toContain(twPlaceKey(county.name));
      for (const other of counties) if (other !== county) expect(other.keys, `${other.name} / ${county.name}`).not.toContain(twPlaceKey(county.name));
    }
  });

  it('ACCEPT: answers 404 feature_disabled on GoApply', async () => {
    const { h } = await start();
    const res = await h.request<Fail>('GET', `${P}/districts`, { host: GO });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
  });
});

describe('the mount table', () => {
  it('mounts the two routers: a public one for the note and the filter, an admin one for the rule, the admin one before the console catch-all', () => {
    const tw = FEATURE_MOUNTS.find((m) => m.id === 'tw')!;
    const admin = FEATURE_MOUNTS.find((m) => m.id === 'tw.admin')!;
    expect(tw).toMatchObject({ area: 'tw', path: P, kind: 'public', owner: 'MKT-5F' });
    expect(admin).toMatchObject({ area: 'tw', path: A, kind: 'admin', owner: 'MKT-5F' });
    expect(FEATURE_MOUNTS.indexOf(admin)).toBeLessThan(FEATURE_MOUNTS.findIndex((m) => m.id === 'admin'));
  });
});
