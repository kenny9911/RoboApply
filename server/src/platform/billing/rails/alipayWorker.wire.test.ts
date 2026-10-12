// @vitest-environment node
//
// The request GoApply sends to the Alipay worker, against production's shape
// (MARKET_STRATEGY §5.3 G6, G7, G8, G10; requirement AL-3). The frozen rules
// A5 and A6 live in rails.test.ts and are not repeated here: this file pins
// what AL-3 brought back to production's shape and what it added.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { logger } from '../../../services/LoggerService.js';
import { getBrand } from '../../brand/registry.js';
import { getPlan } from '../planCatalog.js';
import { resetAlipayNotifyOriginLogForTests } from '../origins.js';
import {
  ALIPAY_CALLBACK_PATH,
  ALIPAY_LEGACY_PACKAGE_ID,
  ALIPAY_ORDER_PREFIX,
  alipayPackageIdMode,
  createAlipayWorkerRail,
  logAlipayNotifyHostOnce,
  newOutTradeNo,
  resetAlipayNotifyHostLogForTests,
  resetAlipaySecretlessLogForTests,
  type AlipayRailDb,
} from './alipayWorker.js';
import { ensureDefaultRails, getRegisteredRail, registerRail, unregisterRail } from './index.js';
import type { CheckoutOrder } from './types.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');
const SECRET = 'cb+secret&? /=';
// What a GoApply deployment sets to sell through Alipay: the callback secret, nothing else.
const BASE = { ALIPAY_CALLBACK_SECRET: SECRET };
type Env = Record<string, string>;

const go = getBrand('goapply');
const ra = getBrand('roboapply');

/**
 * SYNTHETIC. The request production sends for a ¥19 Starter order, built from
 * the field table in docs/jobright-clone/market/PAYMENTS_AUDIT.md §A2 (read
 * from production's code). It is NOT a captured request: the supervised first
 * order (AL-8) is what captures one.
 */
const PRODUCTION_SHAPE = {
  out_trade_no: 'RAORDER_20261010080000_user_123_k3j9x0aa',
  total_amount: 19,
  subject: 'RoboApply Starter 月度订阅',
  pay_channel: 'alipay',
  user_name: 'U',
  user_email: 'u@example.test',
  user_id: 'user_123456789',
  platform: 'gohire',
  package_data: { package_id: 'starter', package_name: 'starter', package_type: '1', package_price: '19' },
  notify_url: `https://www.roboapply.io/api/v1/roboapply/billing/alipay/callback?cb=${encodeURIComponent(SECRET)}`,
  return_url: 'https://www.roboapply.io/account?billing=success',
};

function order(planKey: string, env: Env, over: Partial<CheckoutOrder> = {}): CheckoutOrder {
  return {
    brand: go,
    plan: getPlan('goapply', planKey as never, env)!,
    user: { id: 'user_123456789', email: 'u@example.test', name: 'U' },
    seekerProfileId: 'sp_1',
    acknowledgements: { autoRenewAck: false, withdrawalWaiver: false },
    ...over,
  };
}

async function send(planKey = 'pro_monthly', env: Env = BASE, over: Partial<CheckoutOrder> = {}) {
  const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { pay_url: 'https://alipay.test/pay' } }) }));
  const db = createFakePrisma();
  const rail = createAlipayWorkerRail({ fetch: fetchImpl as unknown as typeof fetch, env, now: () => NOW, getDb: async () => db as unknown as AlipayRailDb });
  const res = await rail.createCheckout(order(planKey, env, over));
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
  return { res, url, payload: JSON.parse(init.body) as Record<string, any>, db };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetAlipayNotifyOriginLogForTests();
  resetAlipayNotifyHostLogForTests();
  resetAlipaySecretlessLogForTests();
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
});
afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  vi.unstubAllEnvs();
  resetAlipayNotifyHostLogForTests();
  resetAlipaySecretlessLogForTests();
});

describe('the request body is production\'s shape (AL-3)', () => {
  it('with no collecting entity the keys sent are exactly production\'s, no more and no less', async () => {
    const { payload } = await send();
    expect(Object.keys(payload).sort()).toEqual(
      ['out_trade_no', 'total_amount', 'subject', 'pay_channel', 'user_name', 'user_email', 'user_id', 'platform', 'package_data', 'notify_url', 'return_url'].sort(),
    );
    expect(Object.keys(payload).sort()).toEqual(Object.keys(PRODUCTION_SHAPE).sort());
    expect(payload).not.toHaveProperty('body');
    expect(Object.keys(payload.package_data).sort()).toEqual(Object.keys(PRODUCTION_SHAPE.package_data).sort());
    // Every field has production's type.
    for (const [k, v] of Object.entries(PRODUCTION_SHAPE)) expect(typeof payload[k], k).toBe(typeof v);
    for (const [k, v] of Object.entries(PRODUCTION_SHAPE.package_data)) expect(typeof payload.package_data[k], k).toBe(typeof v);
  });

  it('differs from production only in subject, amount, the package fields and the hosts of notify_url and return_url', async () => {
    const { payload } = await send();
    // Identical values.
    for (const k of ['pay_channel', 'user_name', 'user_email', 'user_id', 'platform'] as const) expect(payload[k], k).toBe(PRODUCTION_SHAPE[k]);
    expect(payload.package_data.package_type).toBe(PRODUCTION_SHAPE.package_data.package_type);
    // The order number has production's prefix, timestamp and user part (the random suffix differs by nature).
    const head = (no: string) => no.split('_').slice(0, 4).join('_');
    expect(head(payload.out_trade_no)).toBe(head(PRODUCTION_SHAPE.out_trade_no));
    // The notify URL: production's path and `cb` parameter, on GoApply's own host.
    const mine = new URL(payload.notify_url);
    const theirs = new URL(PRODUCTION_SHAPE.notify_url);
    expect(mine.pathname).toBe(theirs.pathname);
    expect(mine.search).toBe(theirs.search);
    expect(mine.protocol).toBe('https:');
    expect([mine.host, theirs.host]).toEqual(['www.goapply.top', 'www.roboapply.io']);
    // The return URL is on GoApply's app origin (its path is the web app's route).
    expect(new URL(payload.return_url).origin).toBe('https://www.goapply.top');
    expect(new URL(payload.return_url).searchParams.get('billing')).toBe('success');
    // What does differ, and is meant to: the product sold.
    expect(payload).toMatchObject({ subject: 'GoApply 会员月卡', total_amount: 39, package_data: { package_id: 'pro_monthly', package_name: 'pro_monthly', package_price: '39' } });
  });

  it('body is sent only with a collecting entity: "<subject> · <entity>", at most 200 characters', async () => {
    expect((await send()).payload).not.toHaveProperty('body');
    expect((await send('pro_monthly', { ...BASE, CN_PAYMENT_COLLECTING_ENTITY: '   ' })).payload).not.toHaveProperty('body');
    // Another brand's entity is never GoApply's.
    expect((await send('pro_monthly', { ...BASE, PAYMENT_COLLECTING_ENTITY: 'RoboApply Inc.' })).payload).not.toHaveProperty('body');

    const named = (await send('pro_monthly', { ...BASE, CN_PAYMENT_COLLECTING_ENTITY: 'Example Collecting Co.' })).payload;
    expect(named.body).toBe('GoApply 会员月卡 · Example Collecting Co.');
    // The key sits where it always did, right after the subject, and nothing else moved.
    expect(Object.keys(named)).toEqual(['out_trade_no', 'total_amount', 'subject', 'body', 'pay_channel', 'user_name', 'user_email', 'user_id', 'platform', 'package_data', 'notify_url', 'return_url']);

    const long = (await send('pro_monthly', { ...BASE, CN_PAYMENT_COLLECTING_ENTITY: '示'.repeat(400) })).payload;
    expect(long.body).toHaveLength(200);
    expect(long.body.startsWith('GoApply 会员月卡 · 示')).toBe(true);
  });
});

describe('the order number is RAORDER_ for both brands (G7)', () => {
  const PATTERN = /^RAORDER_\d{14}_.{1,8}_[0-9a-f]{10}$/;

  it('a GoApply order number matches production\'s prefix; the brand is in the order row', async () => {
    const { payload, db, res } = await send();
    expect(ALIPAY_ORDER_PREFIX).toBe('RAORDER');
    expect(payload.out_trade_no).toMatch(PATTERN);
    expect(payload.out_trade_no).toMatch(/^RAORDER_20261010080000_user_123_[0-9a-f]{10}$/);
    expect(payload.out_trade_no).not.toContain('GAORDER');
    expect((res as { orderId: string }).orderId).toBe(payload.out_trade_no);
    const row = await db.alipayOrder.findUnique({ where: { outTradeNo: payload.out_trade_no } });
    expect(row).toMatchObject({ brand: 'goapply', tier: 'ra_pro_monthly', planKey: 'pro_monthly', amount: 39, amountMinor: 3900, status: 'pending', channel: 'alipay' });
  });

  it('both brands, and a user id of any shape (the middle part is its first 8 characters and may hold an underscore)', () => {
    for (const brand of [go, ra]) {
      for (const userId of ['user_123456789', 'cmf9x2k4q0001abcd', 'u1', 'a_b_c_d_e_f']) {
        const no = newOutTradeNo(brand, userId, NOW);
        expect(no, `${brand.id} ${userId}`).toMatch(PATTERN);
        expect(no.startsWith(`RAORDER_20261010080000_${userId.slice(0, 8)}_`)).toBe(true);
      }
    }
    // Two orders in the same second for the same user still differ.
    expect(newOutTradeNo(go, 'user_123456789', NOW)).not.toBe(newOutTradeNo(go, 'user_123456789', NOW));
  });
});

describe('package_data.package_id: the plan key, or production\'s id in legacy mode (G10)', () => {
  it('default: the plan key in package_id and package_name', async () => {
    expect((await send('pro_monthly')).payload.package_data).toEqual({ package_id: 'pro_monthly', package_name: 'pro_monthly', package_type: '1', package_price: '39' });
    expect((await send('practice_pack_5')).payload.package_data).toEqual({ package_id: 'practice_pack_5', package_name: 'practice_pack_5', package_type: '1', package_price: '29' });
    for (const mode of ['', '  ', 'plan_key', 'starter', 'on', 'true']) {
      const env = { ...BASE, CN_ALIPAY_PACKAGE_ID_MODE: mode };
      expect(alipayPackageIdMode(go, env), mode).toBe('plan_key');
      expect((await send('pro_monthly', env)).payload.package_data.package_id, mode).toBe('pro_monthly');
    }
  });

  it('CN_ALIPAY_PACKAGE_ID_MODE=legacy: package_id is "starter", the plan key stays in package_name, type and price are unchanged', async () => {
    expect(ALIPAY_LEGACY_PACKAGE_ID).toBe(PRODUCTION_SHAPE.package_data.package_id);
    for (const mode of ['legacy', ' Legacy ', 'LEGACY']) {
      const env = { ...BASE, CN_ALIPAY_PACKAGE_ID_MODE: mode };
      expect(alipayPackageIdMode(go, env), mode).toBe('legacy');
      const month = await send('pro_monthly', env);
      expect(month.payload.package_data, mode).toEqual({ package_id: 'starter', package_name: 'pro_monthly', package_type: '1', package_price: '39' });
      // Nothing else on the wire moves with the mode.
      const plain = (await send('pro_monthly')).payload;
      expect({ ...month.payload, package_data: null, out_trade_no: null }).toEqual({ ...plain, package_data: null, out_trade_no: null });
      // The stored order still names the plan that was bought.
      expect(await month.db.alipayOrder.findUnique({ where: { outTradeNo: month.payload.out_trade_no } })).toMatchObject({ tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amountMinor: 3900 });
    }
    const pack = await send('practice_pack_5', { ...BASE, CN_ALIPAY_PACKAGE_ID_MODE: 'legacy' });
    expect(pack.payload.package_data).toEqual({ package_id: 'starter', package_name: 'practice_pack_5', package_type: '1', package_price: '29' });
    expect(await pack.db.alipayOrder.findUnique({ where: { outTradeNo: pack.payload.out_trade_no } })).toMatchObject({ tier: 'ra_practice_pack_5', brand: 'goapply', purpose: 'interview_pack' });
  });

  it('the mode is GoApply\'s: it is never read for RoboApply', () => {
    expect(alipayPackageIdMode(ra, { CN_ALIPAY_PACKAGE_ID_MODE: 'legacy' })).toBe('plan_key');
  });
});

describe('notify_url is on GoApply\'s own host (G8)', () => {
  const notifyOf = async (env: Env) => new URL((await send('pro_monthly', { ...BASE, ...env })).payload.notify_url);

  it.each([
    ['an empty environment', {}, 'www.goapply.top'],
    ['CN_BACKEND_URL', { CN_BACKEND_URL: 'https://api.goapply.example/' }, 'api.goapply.example'],
    ['CN_ALIPAY_NOTIFY_ORIGIN wins over CN_BACKEND_URL', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' }, 'pay.goapply.example'],
    ['BACKEND_URL alone changes nothing', { BACKEND_URL: 'https://www.roboapply.io' }, 'www.goapply.top'],
    ['BACKEND_URL next to CN_BACKEND_URL', { BACKEND_URL: 'https://www.roboapply.io', CN_BACKEND_URL: 'https://api.goapply.example' }, 'api.goapply.example'],
    ['an http override is ignored', { CN_ALIPAY_NOTIFY_ORIGIN: 'http://pay.goapply.example' }, 'www.goapply.top'],
    ['a malformed override is ignored', { CN_ALIPAY_NOTIFY_ORIGIN: 'pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' }, 'api.goapply.example'],
  ] as const)('%s → %s', async (_name, env, host) => {
    const notify = await notifyOf(env);
    expect(notify.host).toBe(host);
    expect(notify.protocol).toBe('https:');
    // The route, with no double slash, and the secret URL-encoded as the only parameter (rule A5).
    expect(notify.pathname).toBe(ALIPAY_CALLBACK_PATH);
    expect(notify.href).toBe(`https://${host}${ALIPAY_CALLBACK_PATH}?cb=${encodeURIComponent(SECRET)}`);
    expect([...notify.searchParams]).toEqual([['cb', SECRET]]);
    expect(notify.href).not.toContain(SECRET);
  });

  it('an ignored override is logged once, by variable name and reason, never by value', async () => {
    await notifyOf({ CN_ALIPAY_NOTIFY_ORIGIN: 'http://pay.goapply.example/?cb=PASTED-SECRET' });
    await notifyOf({ CN_ALIPAY_NOTIFY_ORIGIN: 'http://pay.goapply.example/?cb=PASTED-SECRET' });
    const ignored = warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('CN_ALIPAY_NOTIFY_ORIGIN'));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]![0]).toBe('RA_BILLING');
    expect(ignored[0]![2]).toEqual({ variable: 'CN_ALIPAY_NOTIFY_ORIGIN', reason: 'not_https', usedInstead: 'canonical' });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('PASTED-SECRET');
  });

  it('return_url stays on the GoApply app origin whatever the notify origin is', async () => {
    const env = { ...BASE, CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' };
    expect((await send('pro_monthly', env)).payload.return_url).toBe('https://www.goapply.top/settings/billing/return?billing=success');
    // The app origin has its own variable; the notify origin does not follow it.
    const moved = (await send('pro_monthly', { ...BASE, CN_CANONICAL_ORIGIN: 'https://app.goapply.example/' })).payload;
    expect(moved.return_url).toBe('https://app.goapply.example/settings/billing/return?billing=success');
    expect(new URL(moved.notify_url).host).toBe('www.goapply.top');
    // A caller's return path is kept.
    expect((await send('pro_monthly', env, { successPath: '/jobs?from=wall' })).payload.return_url).toBe('https://www.goapply.top/jobs?from=wall&billing=success');
  });

  it('without a callback secret in the environment the notify URL carries no cb (the rail cannot charge then; the URL is still well formed)', async () => {
    const { payload } = await send('pro_monthly', {});
    expect(payload.notify_url).toBe(`https://www.goapply.top${ALIPAY_CALLBACK_PATH}`);
  });
});

describe('the notify host is logged at startup: the host only, and which variable decided it (G8)', () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => String(c[1]).includes('Alipay notify host'));
  type Line = (tag: string, message: string, meta?: Record<string, unknown>) => void;
  /** A logger with both levels: the line is info, and a warning when an override was ignored. */
  const sink = () => ({ info: vi.fn<Line>(), warn: vi.fn<Line>() });

  it.each([
    ['nothing set', {}, 'www.goapply.top', 'canonical', 'the brand origin (no variable set)'],
    ['CN_BACKEND_URL', { CN_BACKEND_URL: 'https://api.goapply.example/' }, 'api.goapply.example', 'CN_BACKEND_URL', 'CN_BACKEND_URL'],
    ['the override', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example:8443', CN_BACKEND_URL: 'https://api.goapply.example' }, 'pay.goapply.example:8443', 'CN_ALIPAY_NOTIFY_ORIGIN', 'CN_ALIPAY_NOTIFY_ORIGIN'],
    ['BACKEND_URL alone', { BACKEND_URL: 'https://www.roboapply.io' }, 'www.goapply.top', 'canonical', 'the brand origin (no variable set)'],
  ] as const)('%s', (_name, env, host, source, decidedBy) => {
    const log = sink();
    expect(logAlipayNotifyHostOnce({ ...BASE, ...env }, log)).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    // Nothing was ignored: it is an info line, not a warning.
    expect(log.warn).not.toHaveBeenCalled();
    const [tag, message, meta] = log.info.mock.calls[0]!;
    expect(tag).toBe('RA_BILLING');
    expect(message).toBe(`GoApply Alipay notify host: ${host} (decided by ${decidedBy})`);
    expect(meta).toEqual({ host, source, callbackPath: ALIPAY_CALLBACK_PATH });
  });

  it('never prints the callback secret, a scheme, a query or a full URL', () => {
    const log = sink();
    const env = { ...BASE, CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' };
    logAlipayNotifyHostOnce(env, log);
    const printed = JSON.stringify([log.info.mock.calls, log.warn.mock.calls]);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(encodeURIComponent(SECRET));
    expect(printed).not.toMatch(/cb=|\?|https?:\/\//);
  });

  it('an ignored override is a WARNING that says so, by variable and reason, never by value', () => {
    const log = sink();
    // The likely mistake: the whole callback URL pasted from the pre-flight command.
    expect(logAlipayNotifyHostOnce({ ...BASE, CN_ALIPAY_NOTIFY_ORIGIN: 'https://www.goapply.top/api/v1/x?cb=PASTED-SECRET' }, log)).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [tag, message, meta] = log.warn.mock.calls[0]!;
    expect(tag).toBe('RA_BILLING');
    expect(message).toBe(
      'GoApply Alipay notify host: www.goapply.top (CN_ALIPAY_NOTIFY_ORIGIN is set and ignored: it is not a bare origin (it carries a path, a query, a fragment or credentials); decided by the brand origin)',
    );
    // "(no variable set)" would be untrue here: the variable IS set.
    expect(message).not.toContain('no variable set');
    expect(meta).toEqual({ host: 'www.goapply.top', source: 'canonical', callbackPath: ALIPAY_CALLBACK_PATH, ignored: { variable: 'CN_ALIPAY_NOTIFY_ORIGIN', reason: 'not_an_origin' } });
    const printed = JSON.stringify(log.warn.mock.calls);
    expect(printed).not.toContain('PASTED-SECRET');
    expect(printed).not.toMatch(/cb=|\?|https?:\/\//);
  });

  it.each([
    ['http, not https', 'http://pay.goapply.example', {}, 'it is not https', 'not_https', 'www.goapply.top', 'canonical', 'the brand origin'],
    ['not a URL', 'pay.goapply.example', {}, 'it is not a URL', 'malformed', 'www.goapply.top', 'canonical', 'the brand origin'],
    ['a path, with CN_BACKEND_URL set', 'https://pay.goapply.example/notify', { CN_BACKEND_URL: 'https://api.goapply.example' }, 'it is not a bare origin (it carries a path, a query, a fragment or credentials)', 'not_an_origin', 'api.goapply.example', 'CN_BACKEND_URL', 'CN_BACKEND_URL'],
  ] as const)('an ignored override, %s: the warning names the reason and what decided the host instead', (_name, override, more, words, reason, host, source, decidedBy) => {
    const log = sink();
    logAlipayNotifyHostOnce({ ...BASE, ...more, CN_ALIPAY_NOTIFY_ORIGIN: override }, log);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toBe(`GoApply Alipay notify host: ${host} (CN_ALIPAY_NOTIFY_ORIGIN is set and ignored: ${words}; decided by ${decidedBy})`);
    expect(log.warn.mock.calls[0]![2]).toEqual({ host, source, callbackPath: ALIPAY_CALLBACK_PATH, ignored: { variable: 'CN_ALIPAY_NOTIFY_ORIGIN', reason } });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(override);
  });

  it('the warning is said once, and the plain line replaces it once the override is fixed', () => {
    const log = sink();
    const bad = { ...BASE, CN_ALIPAY_NOTIFY_ORIGIN: 'http://pay.goapply.example' };
    expect(logAlipayNotifyHostOnce(bad, log)).toBe(true);
    expect(logAlipayNotifyHostOnce(bad, log)).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(logAlipayNotifyHostOnce({ ...BASE, CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' }, log)).toBe(true);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toBe('GoApply Alipay notify host: pay.goapply.example (decided by CN_ALIPAY_NOTIFY_ORIGIN)');
  });

  it('one line per process: asked again it is silent, unless the answer changed (an .env loaded after the rail was registered)', () => {
    const log = sink();
    expect(logAlipayNotifyHostOnce({}, log)).toBe(true);
    expect(logAlipayNotifyHostOnce({}, log)).toBe(false);
    expect(logAlipayNotifyHostOnce({ BACKEND_URL: 'https://www.roboapply.io' }, log)).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
    // The entry point loads .env: the host is now another one, and that is said, once.
    const loaded = { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' };
    expect(logAlipayNotifyHostOnce(loaded, log)).toBe(true);
    expect(logAlipayNotifyHostOnce(loaded, log)).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info.mock.calls[1]![1]).toBe('GoApply Alipay notify host: pay.goapply.example (decided by CN_ALIPAY_NOTIFY_ORIGIN)');
    // `force` (tests) ignores the guard.
    expect(logAlipayNotifyHostOnce(loaded, log, { force: true })).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the deployment does not serve GoApply, and a failing logger never throws', () => {
    const log = sink();
    expect(logAlipayNotifyHostOnce({ ALLOWED_BRANDS: 'roboapply' }, log)).toBe(false);
    expect(logAlipayNotifyHostOnce({ BRAND_LOCK: 'roboapply' }, log)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    const boom = () => {
      throw new Error('log sink down');
    };
    const broken = { info: vi.fn(boom), warn: vi.fn(boom) };
    expect(logAlipayNotifyHostOnce({}, broken)).toBe(false);
    expect(logAlipayNotifyHostOnce({ CN_ALIPAY_NOTIFY_ORIGIN: 'nope' }, broken)).toBe(false);
    // Not marked as said: the next ask logs it.
    expect(logAlipayNotifyHostOnce({}, log)).toBe(true);
  });

  describe('when it is asked for', () => {
    beforeEach(() => {
      for (const k of ['CN_ALIPAY_NOTIFY_ORIGIN', 'CN_BACKEND_URL', 'BACKEND_URL', 'ALLOWED_BRANDS', 'BRAND_LOCK', 'CN_PAYMENT_COLLECTING_ENTITY', 'CN_PAYMENT_REQUIRE_ENTITY', 'ALIPAY_SECRETLESS_UNTIL']) vi.stubEnv(k, '');
      vi.stubEnv('ALIPAY_CALLBACK_SECRET', SECRET);
    });

    it('ensureDefaultRails logs it when it registers the Alipay rail, and not when the rail is already there', () => {
      const before = getRegisteredRail('alipay');
      try {
        unregisterRail('alipay');
        ensureDefaultRails();
        expect(getRegisteredRail('alipay')?.id).toBe('alipay');
        expect(lines(infoSpy)).toHaveLength(1);
        expect(lines(infoSpy)[0]![0]).toBe('RA_BILLING');
        expect(lines(infoSpy)[0]![1]).toBe('GoApply Alipay notify host: www.goapply.top (decided by the brand origin (no variable set))');
        expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(SECRET);
        // Already registered (a test rail, a later wave): nothing is replaced and nothing is said.
        const registered = getRegisteredRail('alipay');
        resetAlipayNotifyHostLogForTests();
        ensureDefaultRails();
        expect(getRegisteredRail('alipay')).toBe(registered);
        expect(lines(infoSpy)).toHaveLength(1);
      } finally {
        if (before) registerRail('alipay', before);
      }
    });

    it('the rail asks again the first time the running deployment checks whether GoApply can charge', () => {
      const rail = createAlipayWorkerRail();
      // Registered before `.env` was read: the line named the default host.
      logAlipayNotifyHostOnce(process.env);
      expect(lines(infoSpy)).toHaveLength(1);
      // The entry point loads `.env`; the next plans read says where notifies really go, once.
      vi.stubEnv('CN_ALIPAY_NOTIFY_ORIGIN', 'https://pay.goapply.example');
      rail.isConfigured(go, process.env);
      rail.isConfigured(go, process.env);
      expect(lines(infoSpy)).toHaveLength(2);
      expect(lines(infoSpy)[1]![1]).toBe('GoApply Alipay notify host: pay.goapply.example (decided by CN_ALIPAY_NOTIFY_ORIGIN)');
      // Never for RoboApply, never for an environment a caller is merely evaluating.
      rail.isConfigured(ra, process.env);
      rail.isConfigured(go, { ...BASE, CN_BACKEND_URL: 'https://api.goapply.example' });
      expect(lines(infoSpy)).toHaveLength(2);
    });

    it('an override that is set and ignored is a warning from the first ask, not at the first order', () => {
      vi.stubEnv('CN_ALIPAY_NOTIFY_ORIGIN', 'https://www.goapply.top/api/v1/roboapply/billing/alipay/callback?cb=PASTED-SECRET');
      const rail = createAlipayWorkerRail();
      rail.isConfigured(go, process.env);
      rail.isConfigured(go, process.env);
      expect(lines(infoSpy)).toHaveLength(0);
      expect(lines(warnSpy)).toHaveLength(1);
      expect(String(lines(warnSpy)[0]![1])).toContain('CN_ALIPAY_NOTIFY_ORIGIN is set and ignored');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('PASTED-SECRET');
    });
  });
});
