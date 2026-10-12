// @vitest-environment node
//
// Callback tolerance at the rail (MARKET_STRATEGY §5.3 G9 and G4; requirement
// AL-4): `total_amount` in yuan or in fen, an unusable value treated as not
// stated, and the secret-less window for orders production created before the
// cut-over (and its state, said at startup).
// The frozen rule A6 lives in rails.test.ts; the route answers are pinned in
// roboapply/services/RoboApplyBillingService.alipay.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createFakePrisma } from '../../../test/fakePrisma.js';
import { logger } from '../../../services/LoggerService.js';
import {
  ALIPAY_MAX_PLAUSIBLE_YUAN,
  ALIPAY_SECRETLESS_WINDOW_DAYS,
  ALIPAY_SECRETLESS_WINDOW_MS,
  alipaySecretlessEligible,
  alipaySecretlessUntil,
  alipaySecretlessWindowState,
  createAlipayWorkerRail,
  logAlipaySecretlessWindowOnce,
  readAlipayTotalAmount,
  reportAlipayRailOnce,
  resetAlipayNotifyHostLogForTests,
  resetAlipaySecretlessLogForTests,
  type AlipayRailDb,
} from './alipayWorker.js';
import { CallbackRejectedError, type CallbackInput } from './types.js';

const SECRET = 'cb+secret&?';
const NOW = new Date('2026-10-21T08:00:00.000Z');
const ORDER = 'RAORDER_20261010080000_user_123_0123456789';
const DAY = 24 * 60 * 60 * 1000;

/** One pending ¥39 order (3900 fen), and a rail over it that counts every database access. */
function world(opts: { env?: Record<string, string>; now?: Date; rows?: Array<Record<string, unknown>> } = {}) {
  const db = createFakePrisma({
    seed: {
      alipayOrder: opts.rows ?? [
        { id: 'o_1', userId: 'cn_user', outTradeNo: ORDER, tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', channel: 'alipay', amount: 39, amountMinor: 3900, status: 'pending', createdAt: new Date('2026-10-10T08:00:00.000Z') },
      ],
    },
  });
  const findUnique = vi.spyOn(db.alipayOrder, 'findUnique');
  const getDb = vi.fn(async () => db as unknown as AlipayRailDb);
  const rail = createAlipayWorkerRail({ env: opts.env ?? { ALIPAY_CALLBACK_SECRET: SECRET }, now: () => opts.now ?? NOW, getDb, fetch: vi.fn() as unknown as typeof fetch });
  return { db, rail, getDb, findUnique };
}

/** A paid notify with the secret, as the worker sends it (query string). */
const paid = (over: Record<string, unknown> = {}): CallbackInput => ({ query: { cb: SECRET, pay_status: 'TRADE_SUCCESS', out_trade_no: ORDER, ...over }, body: {}, headers: {} });

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetAlipaySecretlessLogForTests();
  resetAlipayNotifyHostLogForTests();
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
});
afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  vi.unstubAllEnvs();
  resetAlipaySecretlessLogForTests();
  resetAlipayNotifyHostLogForTests();
});

const notUsable = () => warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('total_amount is not usable'));
const readAsFen = () => infoSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('read as fen'));

describe('total_amount: yuan or fen (G9)', () => {
  // What `fulfilPass` compares with the order (3900): equal fulfils, different is refused (40004), null is "not stated".
  it.each([
    ['39.00 (yuan, two decimals)', '39.00', 3900, 0],
    ['39 (yuan, whole)', '39', 3900, 0],
    ['39.0 (yuan, one decimal)', '39.0', 3900, 0],
    ['3900 (fen: exactly 100 times the price)', '3900', 3900, 1],
    ['40.00 (a real mismatch)', '40.00', 4000, 0],
    ['38.99 (a real mismatch)', '38.99', 3899, 0],
    ['4000 (neither the price in yuan nor in fen)', '4000', 400_000, 1],
    ['390000 (fen of a price 100 times higher)', '390000', 39_000_000, 1],
    ['3900.00 (a decimal point: yuan, never fen)', '3900.00', 390_000, 0],
    ['3950 (not a multiple of 100: cannot be whole-yuan fen)', '3950', 395_000, 0],
  ] as const)('%s', async (_name, total, paidAmountMinor, reads) => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid({ total_amount: total }))).resolves.toEqual({ outTradeNo: ORDER, status: 'paid', paidAmountMinor, transactionId: null });
    expect(w.getDb).toHaveBeenCalledTimes(reads);
    expect(w.findUnique).toHaveBeenCalledTimes(reads);
    expect(notUsable()).toHaveLength(0);
  });

  it('the fen read is one lookup by order number, of the two amount columns, and it is logged as fen once', async () => {
    const w = world();
    await w.rail.verifyCallback!(paid({ total_amount: '3900' }));
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    expect(w.findUnique).toHaveBeenCalledWith({ where: { outTradeNo: ORDER }, select: { amount: true, amountMinor: true } });
    expect(readAsFen()).toHaveLength(1);
    expect(readAsFen()[0]![0]).toBe('RA_BILLING');
    expect(readAsFen()[0]![2]).toEqual({ outTradeNo: ORDER, expectedMinor: 3900 });
    // A yuan amount is never logged as fen.
    infoSpy.mockClear();
    await w.rail.verifyCallback!(paid({ total_amount: '39.00' }));
    await w.rail.verifyCallback!(paid({ total_amount: '4000' }));
    expect(readAsFen()).toHaveLength(0);
  });

  it('a missing total_amount is "not stated", with no database access and no log', async () => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid())).resolves.toEqual({ outTradeNo: ORDER, status: 'paid', paidAmountMinor: null, transactionId: null });
    await expect(w.rail.verifyCallback!({ query: { cb: SECRET }, body: { pay_status: 'TRADE_SUCCESS', out_trade_no: ORDER, total_amount: null }, headers: {} })).resolves.toMatchObject({ paidAmountMinor: null });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(notUsable()).toHaveLength(0);
  });

  it('a JSON number in the body is read the same way: 39 is yuan (no read), 3900 is fen (one read)', async () => {
    const w = world();
    const body = (total_amount: unknown): CallbackInput => ({ query: { cb: SECRET }, body: { pay_status: 'TRADE_SUCCESS', out_trade_no: ORDER, total_amount }, headers: {} });
    await expect(w.rail.verifyCallback!(body(39))).resolves.toMatchObject({ paidAmountMinor: 3900 });
    await expect(w.rail.verifyCallback!(body(39.0))).resolves.toMatchObject({ paidAmountMinor: 3900 });
    await expect(w.rail.verifyCallback!(body('39.00'))).resolves.toMatchObject({ paidAmountMinor: 3900 });
    expect(w.getDb).not.toHaveBeenCalled();
    await expect(w.rail.verifyCallback!(body(3900))).resolves.toMatchObject({ paidAmountMinor: 3900 });
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    await expect(w.rail.verifyCallback!(body(40))).resolves.toMatchObject({ paidAmountMinor: 4000 });
    expect(w.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['letters', 'abc'],
    ['a negative amount', '-39'],
    ['a plus sign', '+39'],
    ['more than two decimals', '39.001'],
    ['an exponent', '3.9e1'],
    ['a thousands separator', '3,900'],
    ['a currency sign', '¥39'],
    ['blanks around it', ' 39 '],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
  ] as const)('a value that is not well formed is "not stated" and logged by length, never by value: %s', async (_name, total) => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid({ total_amount: total }))).resolves.toEqual({ outTradeNo: ORDER, status: 'paid', paidAmountMinor: null, transactionId: null });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(notUsable()).toHaveLength(1);
    expect(notUsable()[0]![0]).toBe('RA_BILLING');
    expect(notUsable()[0]![2]).toEqual({ outTradeNo: ORDER, reason: 'malformed', rawLength: total.length });
    if (!/^[0.]+$/.test(total)) expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(total);
  });

  it('an empty total_amount, a negative JSON number and a non-scalar are "not stated" and logged too', async () => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid({ total_amount: '' }))).resolves.toMatchObject({ paidAmountMinor: null });
    expect(notUsable().at(-1)![2]).toEqual({ outTradeNo: ORDER, reason: 'malformed', rawLength: 0 });
    const body = (total_amount: unknown): CallbackInput => ({ query: { cb: SECRET }, body: { pay_status: 'TRADE_SUCCESS', out_trade_no: ORDER, total_amount }, headers: {} });
    await expect(w.rail.verifyCallback!(body(-39))).resolves.toMatchObject({ paidAmountMinor: null });
    expect(notUsable().at(-1)![2]).toEqual({ outTradeNo: ORDER, reason: 'malformed', rawLength: 3 });
    await expect(w.rail.verifyCallback!(body({ value: 39 }))).resolves.toMatchObject({ paidAmountMinor: null });
    await expect(w.rail.verifyCallback!(body(true))).resolves.toMatchObject({ paidAmountMinor: null });
    expect(notUsable()).toHaveLength(4);
    expect(w.getDb).not.toHaveBeenCalled();
  });

  it('a value above ¥1,000,000 is implausible: "not stated", logged, no database access', async () => {
    expect(ALIPAY_MAX_PLAUSIBLE_YUAN).toBe(1_000_000);
    const w = world();
    for (const total of ['1000000.01', '1000001', '99999999', '9'.repeat(400)]) {
      warnSpy.mockClear();
      await expect(w.rail.verifyCallback!(paid({ total_amount: total })), total).resolves.toMatchObject({ status: 'paid', paidAmountMinor: null });
      expect(notUsable()).toHaveLength(1);
      expect(notUsable()[0]![2]).toEqual({ outTradeNo: ORDER, reason: 'implausible', rawLength: total.length });
    }
    expect(w.getDb).not.toHaveBeenCalled();
    // Exactly ¥1,000,000 is not above the limit: it is read, as yuan.
    warnSpy.mockClear();
    await expect(w.rail.verifyCallback!(paid({ total_amount: '1000000.00' }))).resolves.toMatchObject({ paidAmountMinor: 100_000_000 });
    expect(notUsable()).toHaveLength(0);
  });

  it('an unknown order number: the yuan reading, so fulfilPass answers not_found as before', async () => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid({ out_trade_no: 'RAORDER_NOPE', total_amount: '3900' }))).resolves.toEqual({ outTradeNo: 'RAORDER_NOPE', status: 'paid', paidAmountMinor: 390_000, transactionId: null });
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    expect(readAsFen()).toHaveLength(0);
  });

  it('when the one read throws, the yuan reading is returned and nothing else throws', async () => {
    // The lookup fails.
    const w = world();
    w.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(w.rail.verifyCallback!(paid({ total_amount: '3900', trade_no: 'T9' }))).resolves.toEqual({ outTradeNo: ORDER, status: 'paid', paidAmountMinor: 390_000, transactionId: 'T9' });
    // The database cannot be opened at all.
    const getDb = vi.fn(async (): Promise<AlipayRailDb> => {
      throw new Error('no connection');
    });
    const closed = createAlipayWorkerRail({ env: { ALIPAY_CALLBACK_SECRET: SECRET }, now: () => NOW, getDb, fetch: vi.fn() as unknown as typeof fetch });
    await expect(closed.verifyCallback!(paid({ total_amount: '3900' }))).resolves.toMatchObject({ status: 'paid', paidAmountMinor: 390_000 });
    expect(getDb).toHaveBeenCalledTimes(1);
    // A database object that throws on every property (the object the A6 tests use).
    const exploding = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } });
    const strict = createAlipayWorkerRail({ env: { ALIPAY_CALLBACK_SECRET: SECRET }, now: () => NOW, getDb: async () => exploding as unknown as AlipayRailDb, fetch: vi.fn() as unknown as typeof fetch });
    await expect(strict.verifyCallback!(paid({ total_amount: '3900' }))).resolves.toMatchObject({ paidAmountMinor: 390_000 });
    for (const total of ['39.00', '39', undefined]) {
      await expect(strict.verifyCallback!(paid(total === undefined ? {} : { total_amount: total }))).resolves.toMatchObject({ paidAmountMinor: total === undefined ? null : 3900 });
    }
    // Each failed read is logged with the order number; the stated value is not.
    const failures = warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('could not be read for the fen check'));
    expect(failures).toHaveLength(3);
    expect(failures[0]![2]).toEqual({ outTradeNo: ORDER, error: 'db down' });
  });

  it('a wrong cb is refused before the order is read, even when the amount could be fen', async () => {
    const w = world();
    for (const cb of ['wrong', '', `${SECRET}x`]) {
      await expect(w.rail.verifyCallback!(paid({ cb, total_amount: '3900' })), cb).rejects.toMatchObject({ reason: 'bad_secret' });
    }
    await expect(w.rail.verifyCallback!({ query: { pay_status: 'TRADE_SUCCESS', out_trade_no: ORDER, total_amount: '3900' }, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'bad_secret' });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(w.findUnique).not.toHaveBeenCalled();
  });

  it('missing parameters are refused before the amount is looked at', async () => {
    const w = world();
    await expect(w.rail.verifyCallback!({ query: { cb: SECRET, pay_status: 'TRADE_SUCCESS', total_amount: '3900' }, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'invalid_params' });
    await expect(w.rail.verifyCallback!({ query: { cb: SECRET, out_trade_no: ORDER, total_amount: 'abc' }, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'invalid_params' });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(notUsable()).toHaveLength(0);
  });

  it('only a paid trade has its amount checked: a closed or waiting trade never reads the order', async () => {
    const w = world();
    await expect(w.rail.verifyCallback!(paid({ pay_status: 'TRADE_CLOSED', total_amount: '3900' }))).resolves.toMatchObject({ status: 'closed' });
    await expect(w.rail.verifyCallback!(paid({ pay_status: 'WAIT_BUYER_PAY', total_amount: '3900' }))).resolves.toMatchObject({ status: 'pending' });
    expect(w.getDb).not.toHaveBeenCalled();
  });

  it('a whole-hundred price: 100 for a ¥100 order is yuan, 10000 is fen, 1000 is neither', async () => {
    const w = world({ rows: [{ id: 'o_h', userId: 'cn_user', outTradeNo: ORDER, tier: 'ra_pro_quarterly', amount: 100, amountMinor: 10_000, status: 'pending' }] });
    await expect(w.rail.verifyCallback!(paid({ total_amount: '100' }))).resolves.toMatchObject({ paidAmountMinor: 10_000 });
    expect(readAsFen()).toHaveLength(0);
    await expect(w.rail.verifyCallback!(paid({ total_amount: '10000' }))).resolves.toMatchObject({ paidAmountMinor: 10_000 });
    expect(readAsFen()).toHaveLength(1);
    await expect(w.rail.verifyCallback!(paid({ total_amount: '1000' }))).resolves.toMatchObject({ paidAmountMinor: 100_000 });
    await expect(w.rail.verifyCallback!(paid({ total_amount: '100.00' }))).resolves.toMatchObject({ paidAmountMinor: 10_000 });
    expect(w.findUnique).toHaveBeenCalledTimes(3);
  });

  it('a legacy order with no amountMinor: the expected amount is its yuan column', async () => {
    const w = world({ rows: [{ id: 'o_l', userId: 'u', outTradeNo: ORDER, tier: 'ra_starter', amount: 19, amountMinor: null, status: 'pending' }] });
    await expect(w.rail.verifyCallback!(paid({ total_amount: '1900' }))).resolves.toMatchObject({ paidAmountMinor: 1900 });
    await expect(w.rail.verifyCallback!(paid({ total_amount: '19.00' }))).resolves.toMatchObject({ paidAmountMinor: 1900 });
    await expect(w.rail.verifyCallback!(paid({ total_amount: '4500' }))).resolves.toMatchObject({ paidAmountMinor: 450_000 });
  });

  it('readAlipayTotalAmount: the reading without the database', () => {
    expect(readAlipayTotalAmount(undefined, false)).toEqual({ minor: null, mayBeFen: false, notStated: null, rawLength: 0 });
    expect(readAlipayTotalAmount(undefined, true)).toEqual({ minor: null, mayBeFen: false, notStated: 'malformed', rawLength: 0 });
    expect(readAlipayTotalAmount('39.00', true)).toEqual({ minor: 3900, mayBeFen: false, notStated: null, rawLength: 5 });
    expect(readAlipayTotalAmount('39', true)).toMatchObject({ minor: 3900, mayBeFen: false });
    // GoApply's catalog prices in fen are all candidates.
    for (const fen of [1200, 3900, 9900, 2900, 7900, 6900]) expect(readAlipayTotalAmount(String(fen), true)).toEqual({ minor: fen * 100, mayBeFen: true, notStated: null, rawLength: 4 });
    expect(readAlipayTotalAmount('19.99', true)).toMatchObject({ minor: 1999, mayBeFen: false });
    expect(readAlipayTotalAmount('1000001', true)).toMatchObject({ minor: null, notStated: 'implausible' });
  });
});

describe('the secret-less window (G4): no cb, only for an order production created before ALIPAY_SECRETLESS_UNTIL, only for 7 days', () => {
  const T = new Date('2026-10-20T08:00:00.000Z');
  const ENV = { ALIPAY_CALLBACK_SECRET: SECRET, ALIPAY_SECRETLESS_UNTIL: '2026-10-20T08:00:00Z' };
  const OLD = 'RAORDER_20261019080000_legacy01_aaaaaaaaaa';
  const NEW = 'RAORDER_20261020080001_user_123_bbbbbbbbbb';
  const AT_T = 'RAORDER_20261020080000_user_123_cccccccccc';
  // Orders THIS code created before the instant. goapply.top sells on this code before roboapply.io is cut over,
  // so at the instant the table already holds them (abandoned checkouts), and the buyer knows the order number.
  const OWN_OLD = 'RAORDER_20261019080000_cn_user__dddddddddd';
  const OWN_WX_OLD = 'GAWX_20261019080000_cn_user__eeeeeeeeee';
  const RA_OLD = 'RAORDER_20261019080000_intluser_ffffffffff';
  const WX_NO_BRAND = 'GAWX_20261019080000_cn_user__0000000000';
  const dayBefore = new Date(T.getTime() - DAY);
  const rows = [
    // Created by production one day before the cut-over. A production row: its table has no brand column, so the
    // brand reads null; `channel` is the column default; no plan key, no fen column.
    { id: 'o_old', userId: 'intl_user', outTradeNo: OLD, tier: 'ra_starter', brand: null, channel: 'alipay', amount: 19, amountMinor: null, status: 'pending', createdAt: dayBefore },
    { id: 'o_own', userId: 'cn_user', outTradeNo: OWN_OLD, tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', channel: 'alipay', amount: 39, amountMinor: 3900, status: 'pending', createdAt: dayBefore },
    { id: 'o_wx', userId: 'cn_user', outTradeNo: OWN_WX_OLD, tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', channel: 'wechatpay', amount: 39, amountMinor: 3900, status: 'pending', createdAt: dayBefore },
    { id: 'o_ra', userId: 'intl_user', outTradeNo: RA_OLD, tier: 'ra_starter', brand: 'roboapply', channel: 'alipay', amount: 19, amountMinor: 1900, status: 'pending', createdAt: dayBefore },
    { id: 'o_wx0', userId: 'cn_user', outTradeNo: WX_NO_BRAND, tier: 'ra_pro_monthly', brand: null, channel: 'wechatpay', amount: 39, amountMinor: 3900, status: 'pending', createdAt: dayBefore },
    // Created one second after it, and exactly at it.
    { id: 'o_new', userId: 'cn_user', outTradeNo: NEW, tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amount: 39, amountMinor: 3900, status: 'pending', createdAt: new Date(T.getTime() + 1000) },
    { id: 'o_t', userId: 'cn_user', outTradeNo: AT_T, tier: 'ra_pro_monthly', planKey: 'pro_monthly', brand: 'goapply', amount: 39, amountMinor: 3900, status: 'pending', createdAt: new Date(T.getTime()) },
  ];
  const noCb = (no: string, over: Record<string, unknown> = {}): CallbackInput => ({ query: { pay_status: 'TRADE_SUCCESS', out_trade_no: no, ...over }, body: {}, headers: {} });
  const accepted = () => warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('accepted without cb'));
  const notProductions = () => warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('was not created by production'));
  const inWindow = new Date(T.getTime() + DAY);

  it('the window is 7 days', () => {
    expect(ALIPAY_SECRETLESS_WINDOW_DAYS).toBe(7);
    expect(ALIPAY_SECRETLESS_WINDOW_MS).toBe(7 * DAY);
  });

  it('inside the window a callback without cb fulfils an order created before the instant, and says so in the log', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(OLD, { trade_no: 'T1' }))).resolves.toEqual({ outTradeNo: OLD, status: 'paid', paidAmountMinor: null, transactionId: 'T1' });
    // One read: when it was created and who created it (brand and channel).
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    expect(w.findUnique).toHaveBeenCalledWith({ where: { outTradeNo: OLD }, select: { createdAt: true, brand: true, channel: true } });
    expect(accepted()).toHaveLength(1);
    expect(accepted()[0]![0]).toBe('RA_BILLING');
    expect(accepted()[0]![2]).toEqual({ outTradeNo: OLD, windowClosesAt: '2026-10-27T08:00:00.000Z' });
    // The body carries the parameters just as well.
    await expect(w.rail.verifyCallback!({ query: {}, body: { pay_status: 'TRADE_CLOSED', out_trade_no: OLD }, headers: {} })).resolves.toMatchObject({ outTradeNo: OLD, status: 'closed' });
  });

  it.each([
    ['a GoApply Alipay order', OWN_OLD],
    ['a GoApply WeChat Pay order', OWN_WX_OLD],
    ['an Alipay order that carries the other brand', RA_OLD],
    ['a WeChat Pay order with no brand', WX_NO_BRAND],
  ] as const)('an order this code created is never fulfilled without cb, however old: %s', async (_name, no) => {
    for (const at of [inWindow, new Date(T.getTime() + 7 * DAY - 1)]) {
      const w = world({ env: ENV, now: at, rows });
      await expect(w.rail.verifyCallback!(noCb(no)), at.toISOString()).rejects.toMatchObject({ reason: 'bad_secret' });
      await expect(w.rail.verifyCallback!(noCb(no, { total_amount: '39.00', trade_no: 'T1' }))).rejects.toBeInstanceOf(CallbackRejectedError);
      await expect(w.rail.verifyCallback!({ query: {}, body: { pay_status: 'TRADE_SUCCESS', out_trade_no: no }, headers: {} })).rejects.toMatchObject({ reason: 'bad_secret' });
    }
    expect(accepted()).toHaveLength(0);
    // Said in the log, by order number: somebody asked to fulfil one of our orders without the secret.
    expect(notProductions().length).toBeGreaterThan(0);
    expect(notProductions()[0]![0]).toBe('RA_BILLING');
    expect(notProductions()[0]![2]).toEqual({ outTradeNo: no });
    // With the secret the same order is fulfilled the ordinary way.
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(no, { cb: SECRET }))).resolves.toMatchObject({ outTradeNo: no, status: 'paid' });
  });

  it('an instant mistyped into the future opens nothing for our own orders: only production\'s rows qualify', async () => {
    // T is a year away, so every order in the table is "created before the instant".
    const env = { ALIPAY_CALLBACK_SECRET: SECRET, ALIPAY_SECRETLESS_UNTIL: '2027-10-20T08:00:00Z' };
    const w = world({ env, now: inWindow, rows });
    for (const no of [OWN_OLD, OWN_WX_OLD, RA_OLD, WX_NO_BRAND, NEW, AT_T]) {
      await expect(w.rail.verifyCallback!(noCb(no)), no).rejects.toMatchObject({ reason: 'bad_secret' });
    }
    expect(accepted()).toHaveLength(0);
    await expect(w.rail.verifyCallback!(noCb(OLD))).resolves.toMatchObject({ outTradeNo: OLD, status: 'paid' });
  });

  it('alipaySecretlessEligible: an Alipay row with no brand, created strictly before the instant', () => {
    const before = new Date(T.getTime() - 1);
    expect(alipaySecretlessEligible({ createdAt: before, brand: null, channel: 'alipay' }, T)).toBe(true);
    expect(alipaySecretlessEligible({ createdAt: T, brand: null, channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible({ createdAt: before, brand: 'goapply', channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible({ createdAt: before, brand: 'roboapply', channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible({ createdAt: before, brand: '', channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible({ createdAt: before, brand: null, channel: 'wechatpay' }, T)).toBe(false);
    // A row that does not say what it is does not qualify (the column is NOT NULL with default 'alipay').
    expect(alipaySecretlessEligible({ createdAt: before, brand: null }, T)).toBe(false);
    expect(alipaySecretlessEligible({ createdAt: before.toISOString(), brand: null, channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible({ brand: null, channel: 'alipay' }, T)).toBe(false);
    expect(alipaySecretlessEligible(null, T)).toBe(false);
  });

  it('an order created one second after the instant, or exactly at it, is refused', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(NEW))).rejects.toMatchObject({ reason: 'bad_secret' });
    await expect(w.rail.verifyCallback!(noCb(AT_T))).rejects.toMatchObject({ reason: 'bad_secret' });
    await expect(w.rail.verifyCallback!(noCb(NEW))).rejects.toBeInstanceOf(CallbackRejectedError);
    expect(accepted()).toHaveLength(0);
  });

  it('an order that does not exist, and a callback that names no order, are refused', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb('RAORDER_NOPE'))).rejects.toMatchObject({ reason: 'bad_secret' });
    expect(w.findUnique).toHaveBeenCalledTimes(1);
    // No order number: nothing to look up, so the database is not opened and the answer is bad_secret (not invalid_params).
    w.getDb.mockClear();
    await expect(w.rail.verifyCallback!({ query: { pay_status: 'TRADE_SUCCESS' }, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'bad_secret' });
    await expect(w.rail.verifyCallback!({ query: {}, body: {}, headers: {} })).rejects.toMatchObject({ reason: 'bad_secret' });
    expect(w.getDb).not.toHaveBeenCalled();
  });

  it('the window closes 7 days after the instant, for good, and then the database is not opened', async () => {
    // The last millisecond inside.
    const last = world({ env: ENV, now: new Date(T.getTime() + 7 * DAY - 1), rows });
    await expect(last.rail.verifyCallback!(noCb(OLD))).resolves.toMatchObject({ outTradeNo: OLD, status: 'paid' });
    // Exactly 7 days, and later.
    for (const at of [new Date(T.getTime() + 7 * DAY), new Date(T.getTime() + 8 * DAY), new Date(T.getTime() + 400 * DAY)]) {
      const w = world({ env: ENV, now: at, rows });
      await expect(w.rail.verifyCallback!(noCb(OLD)), at.toISOString()).rejects.toMatchObject({ reason: 'bad_secret' });
      expect(w.getDb).not.toHaveBeenCalled();
    }
    // The secret still works after the window: nothing else changed.
    const after = world({ env: ENV, now: new Date(T.getTime() + 8 * DAY), rows });
    await expect(after.rail.verifyCallback!({ ...noCb(OLD), query: { ...noCb(OLD).query, cb: SECRET } })).resolves.toMatchObject({ outTradeNo: OLD, status: 'paid' });
    expect(after.getDb).not.toHaveBeenCalled();
  });

  it('before the instant itself the rule is the same: only an order production created before the instant', async () => {
    const w = world({ env: ENV, now: new Date(T.getTime() - 60 * 60 * 1000), rows });
    await expect(w.rail.verifyCallback!(noCb(OLD))).resolves.toMatchObject({ outTradeNo: OLD });
    await expect(w.rail.verifyCallback!(noCb(NEW))).rejects.toMatchObject({ reason: 'bad_secret' });
    // Our own pending orders are older than the instant too, and stay refused.
    await expect(w.rail.verifyCallback!(noCb(OWN_OLD))).rejects.toMatchObject({ reason: 'bad_secret' });
    await expect(w.rail.verifyCallback!(noCb(OWN_WX_OLD))).rejects.toMatchObject({ reason: 'bad_secret' });
  });

  it('a cb that does not match is always refused, inside the window too, without a database read', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    const wrong: CallbackInput[] = [
      noCb(OLD, { cb: 'wrong' }),
      noCb(OLD, { cb: SECRET.slice(0, -1) }),
      // A cb that is there and empty is a cb that does not match.
      noCb(OLD, { cb: '' }),
      noCb(OLD, { cb: ['wrong', SECRET] }),
      { ...noCb(OLD), body: { cb: 'wrong' } },
      { ...noCb(OLD), body: { cb: null } },
      { ...noCb(OLD), headers: { 'x-alipay-callback-secret': 'wrong' } },
      { ...noCb(OLD), headers: { 'x-alipay-callback-secret': '' } },
    ];
    for (const input of wrong) await expect(w.rail.verifyCallback!(input), JSON.stringify(input)).rejects.toMatchObject({ reason: 'bad_secret' });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(w.findUnique).not.toHaveBeenCalled();
    expect(accepted()).toHaveLength(0);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['a word', 'yesterday'],
    ['a date with no time', '2026-10-20'],
    ['a time with no zone', '2026-10-20T08:00:00'],
    ['a number', '1760947200000'],
    ['a month that does not exist', '2026-13-20T08:00:00Z'],
    ['"true"', 'true'],
  ] as const)('with ALIPAY_SECRETLESS_UNTIL %s nothing changes: no cb is refused without any database access', async (_name, value) => {
    const env: Record<string, string> = { ALIPAY_CALLBACK_SECRET: SECRET, ...(value === undefined ? {} : { ALIPAY_SECRETLESS_UNTIL: value }) };
    expect(alipaySecretlessUntil(env)).toBeNull();
    const w = world({ env, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(OLD))).rejects.toMatchObject({ reason: 'bad_secret' });
    await expect(w.rail.verifyCallback!(noCb(OLD))).rejects.toMatchObject({ reason: 'bad_secret' });
    expect(w.getDb).not.toHaveBeenCalled();
    // A value that is set and names no instant is reported once (by variable name), so the operator knows the window is closed.
    const reported = warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('ALIPAY_SECRETLESS_UNTIL is not an ISO instant'));
    expect(reported).toHaveLength(value && value.trim() ? 1 : 0);
    if (value && value.trim()) expect(reported[0]![2]).toEqual({ variable: 'ALIPAY_SECRETLESS_UNTIL' });
  });

  it('alipaySecretlessUntil reads a full ISO instant, with Z or an offset', () => {
    expect(alipaySecretlessUntil({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20T08:00:00Z' })).toEqual(T);
    expect(alipaySecretlessUntil({ ALIPAY_SECRETLESS_UNTIL: ' 2026-10-20T16:00:00+08:00 ' })).toEqual(T);
    expect(alipaySecretlessUntil({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20T08:00:00.000Z' })).toEqual(T);
    expect(alipaySecretlessUntil({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20T08:00Z' })).toEqual(T);
    expect(alipaySecretlessUntil({})).toBeNull();
  });

  it('with no secret configured the answer is still not_configured, whatever the variable says', async () => {
    const w = world({ env: { ALIPAY_SECRETLESS_UNTIL: ENV.ALIPAY_SECRETLESS_UNTIL }, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(OLD))).rejects.toMatchObject({ reason: 'not_configured' });
    await expect(w.rail.verifyCallback!(noCb(OLD, { cb: 'anything' }))).rejects.toMatchObject({ reason: 'not_configured' });
    expect(w.getDb).not.toHaveBeenCalled();
  });

  it('a callback that carries the right cb is not affected by the window: any order, no database read', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(NEW, { cb: SECRET, total_amount: '39.00' }))).resolves.toEqual({ outTradeNo: NEW, status: 'paid', paidAmountMinor: 3900, transactionId: null });
    expect(w.getDb).not.toHaveBeenCalled();
    expect(accepted()).toHaveLength(0);
  });

  it('a secret-less callback gets the same amount reading: fen is recognised, a mismatch is still a mismatch', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    await expect(w.rail.verifyCallback!(noCb(OLD, { total_amount: '1900' }))).resolves.toMatchObject({ paidAmountMinor: 1900 });
    await expect(w.rail.verifyCallback!(noCb(OLD, { total_amount: '19.00' }))).resolves.toMatchObject({ paidAmountMinor: 1900 });
    await expect(w.rail.verifyCallback!(noCb(OLD, { total_amount: '45.00' }))).resolves.toMatchObject({ paidAmountMinor: 4500 });
  });

  it('a database failure inside the window is an exception (the worker retries), never an acceptance', async () => {
    const w = world({ env: ENV, now: inWindow, rows });
    w.findUnique.mockRejectedValueOnce(new Error('db down'));
    const failed = w.rail.verifyCallback!(noCb(OLD));
    await expect(failed).rejects.toThrow('db down');
    await expect(failed).rejects.not.toBeInstanceOf(CallbackRejectedError);
    expect(accepted()).toHaveLength(0);
    // The retry, with the database back, is accepted.
    await expect(w.rail.verifyCallback!(noCb(OLD))).resolves.toMatchObject({ outTradeNo: OLD, status: 'paid' });
  });
});

describe('the secret-less window is reported at startup, before any callback arrives (G4)', () => {
  type Line = (tag: string, message: string, meta?: Record<string, unknown>) => void;
  const sink = () => ({ info: vi.fn<Line>(), warn: vi.fn<Line>() });
  const T = '2026-10-20T08:00:00Z';
  const at = (iso: string) => ({ now: new Date(iso) });

  it.each([
    // (Another date than the one in the message's own example, so "never by value" can be asserted.)
    ['a blank instead of the T', '2026-11-03 08:00:00Z'],
    ['an offset without a colon', '2026-11-03T16:00:00+0800'],
    ['a date with no time', '2026-11-03'],
    ['a time with no zone', '2026-11-03T08:00:00'],
    ['a word', 'tomorrow'],
  ] as const)('a set value that names no instant is a warning, by variable name, never by value: %s', (_name, value) => {
    const log = sink();
    expect(logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: value }, log, at('2026-10-21T08:00:00Z'))).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [tag, message, meta] = log.warn.mock.calls[0]!;
    expect(tag).toBe('RA_BILLING');
    expect(message).toBe(
      'ALIPAY_SECRETLESS_UNTIL is set and names no instant: the Alipay secret-less window is CLOSED. Write a full ISO instant with a zone, for example 2026-10-20T08:00:00Z or 2026-10-20T16:00:00+08:00',
    );
    expect(meta).toEqual({ variable: 'ALIPAY_SECRETLESS_UNTIL' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(value);
    // Once per process and value.
    expect(logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: value }, log, at('2026-10-21T08:00:00Z'))).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a valid instant is one info line: which orders, and when the window closes', () => {
    const log = sink();
    for (const now of ['2026-10-19T00:00:00Z', '2026-10-21T08:00:00Z', '2026-10-27T07:59:59.999Z']) {
      resetAlipaySecretlessLogForTests();
      log.info.mockClear();
      expect(logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: T }, log, at(now)), now).toBe(true);
      expect(log.info).toHaveBeenCalledTimes(1);
      const [tag, message, meta] = log.info.mock.calls[0]!;
      expect(tag).toBe('RA_BILLING');
      expect(message).toBe('Alipay secret-less window: orders created before 2026-10-20T08:00:00.000Z, closes 2026-10-27T08:00:00.000Z');
      expect(meta).toEqual({ variable: 'ALIPAY_SECRETLESS_UNTIL', state: 'open', until: '2026-10-20T08:00:00.000Z', closesAt: '2026-10-27T08:00:00.000Z' });
    }
    expect(log.warn).not.toHaveBeenCalled();
    // An offset is the same instant, printed in UTC.
    resetAlipaySecretlessLogForTests();
    log.info.mockClear();
    logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20T16:00:00+08:00' }, log, at('2026-10-21T08:00:00Z'));
    expect(log.info.mock.calls[0]![1]).toBe('Alipay secret-less window: orders created before 2026-10-20T08:00:00.000Z, closes 2026-10-27T08:00:00.000Z');
  });

  it('once 7 days have passed the line says closed, and since when', () => {
    const log = sink();
    for (const now of ['2026-10-27T08:00:00Z', '2027-01-01T00:00:00Z']) {
      resetAlipaySecretlessLogForTests();
      log.info.mockClear();
      expect(logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: T }, log, at(now)), now).toBe(true);
      expect(log.info.mock.calls[0]![1]).toBe('Alipay secret-less window: closed since 2026-10-27T08:00:00.000Z');
      expect(log.info.mock.calls[0]![2]).toEqual({ variable: 'ALIPAY_SECRETLESS_UNTIL', state: 'closed', until: '2026-10-20T08:00:00.000Z', closesAt: '2026-10-27T08:00:00.000Z' });
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('unset, empty or blank: nothing is said', () => {
    const log = sink();
    for (const env of [{}, { ALIPAY_SECRETLESS_UNTIL: '' }, { ALIPAY_SECRETLESS_UNTIL: '   ' }]) {
      expect(logAlipaySecretlessWindowOnce(env, log)).toBe(false);
    }
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('once per process and answer: silent when asked again, said again when the answer changes', () => {
    const log = sink();
    const env = { ALIPAY_SECRETLESS_UNTIL: T };
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-21T08:00:00Z'))).toBe(true);
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-22T08:00:00Z'))).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
    // The window closes while the process runs: said once more.
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-28T08:00:00Z'))).toBe(true);
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-29T08:00:00Z'))).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(2);
    // The operator corrects a mistyped value: the warning is replaced by the info line.
    resetAlipaySecretlessLogForTests();
    expect(logAlipaySecretlessWindowOnce({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20 08:00:00Z' }, log, at('2026-10-21T08:00:00Z'))).toBe(true);
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-21T08:00:00Z'))).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(3);
    // `force` (tests) ignores the guard; a failing logger never throws and marks nothing as said.
    expect(logAlipaySecretlessWindowOnce(env, log, { force: true, ...at('2026-10-21T08:00:00Z') })).toBe(true);
    resetAlipaySecretlessLogForTests();
    const boom = () => {
      throw new Error('log sink down');
    };
    expect(logAlipaySecretlessWindowOnce(env, { info: vi.fn(boom), warn: vi.fn(boom) }, at('2026-10-21T08:00:00Z'))).toBe(false);
    expect(logAlipaySecretlessWindowOnce(env, log, at('2026-10-21T08:00:00Z'))).toBe(true);
  });

  it('alipaySecretlessWindowState: unset, invalid, open, closed', () => {
    const now = new Date('2026-10-21T08:00:00Z');
    expect(alipaySecretlessWindowState({}, now)).toEqual({ state: 'unset' });
    expect(alipaySecretlessWindowState({ ALIPAY_SECRETLESS_UNTIL: ' ' }, now)).toEqual({ state: 'unset' });
    expect(alipaySecretlessWindowState({ ALIPAY_SECRETLESS_UNTIL: '2026-10-20' }, now)).toEqual({ state: 'invalid' });
    const until = new Date(T);
    const closesAt = new Date(until.getTime() + ALIPAY_SECRETLESS_WINDOW_MS);
    expect(alipaySecretlessWindowState({ ALIPAY_SECRETLESS_UNTIL: T }, now)).toEqual({ state: 'open', until, closesAt });
    expect(alipaySecretlessWindowState({ ALIPAY_SECRETLESS_UNTIL: T }, new Date(closesAt.getTime() - 1))).toMatchObject({ state: 'open' });
    expect(alipaySecretlessWindowState({ ALIPAY_SECRETLESS_UNTIL: T }, closesAt)).toEqual({ state: 'closed', until, closesAt });
  });

  describe('where it is said', () => {
    const windowLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => /secret-less window/.test(String(c[1])));
    beforeEach(() => {
      for (const k of ['CN_ALIPAY_NOTIFY_ORIGIN', 'CN_BACKEND_URL', 'BACKEND_URL', 'ALLOWED_BRANDS', 'BRAND_LOCK', 'CN_PAYMENT_COLLECTING_ENTITY', 'CN_PAYMENT_REQUIRE_ENTITY']) vi.stubEnv(k, '');
      vi.stubEnv('ALIPAY_CALLBACK_SECRET', SECRET);
    });

    it('reportAlipayRailOnce says the notify host and the window; a deployment that does not serve GoApply still hears about the window', () => {
      const log = sink();
      reportAlipayRailOnce({ ALIPAY_SECRETLESS_UNTIL: '2099-01-01T00:00:00Z' }, log);
      expect(log.info.mock.calls.map((c) => c[1])).toEqual([
        'GoApply Alipay notify host: www.goapply.top (decided by the brand origin (no variable set))',
        'Alipay secret-less window: orders created before 2099-01-01T00:00:00.000Z, closes 2099-01-08T00:00:00.000Z',
      ]);
      // The orders the window is for are production's (the other brand's host receives their notifies).
      resetAlipaySecretlessLogForTests();
      const intlOnly = sink();
      reportAlipayRailOnce({ ALLOWED_BRANDS: 'roboapply', ALIPAY_SECRETLESS_UNTIL: '2099-01-01T00:00:00Z' }, intlOnly);
      expect(intlOnly.info.mock.calls.map((c) => c[1])).toEqual(['Alipay secret-less window: orders created before 2099-01-01T00:00:00.000Z, closes 2099-01-08T00:00:00.000Z']);
      // Nothing set: the host line alone.
      resetAlipayNotifyHostLogForTests();
      const plain = sink();
      reportAlipayRailOnce({}, plain);
      expect(plain.info).toHaveBeenCalledTimes(1);
      expect(plain.warn).not.toHaveBeenCalled();
    });

    it('the rail says it the first time the running deployment checks whether GoApply can charge: a mistyped value is a warning before any callback', () => {
      vi.stubEnv('ALIPAY_SECRETLESS_UNTIL', '2026-10-20 08:00:00Z');
      const rail = createAlipayWorkerRail();
      const go = { id: 'goapply', market: 'cn' } as never;
      rail.isConfigured(go, process.env);
      rail.isConfigured(go, process.env);
      const said = warnSpy.mock.calls.filter((c: unknown[]) => String(c[1]).includes('ALIPAY_SECRETLESS_UNTIL is set and names no instant'));
      expect(said).toHaveLength(1);
      expect(said[0]![2]).toEqual({ variable: 'ALIPAY_SECRETLESS_UNTIL' });
      // The operator fixes it (a new process would read it at import): the info line, once.
      vi.stubEnv('ALIPAY_SECRETLESS_UNTIL', '2099-01-01T00:00:00Z');
      rail.isConfigured(go, process.env);
      rail.isConfigured(go, process.env);
      expect(windowLines(infoSpy)).toHaveLength(1);
      expect(windowLines(infoSpy)[0]![1]).toBe('Alipay secret-less window: orders created before 2099-01-01T00:00:00.000Z, closes 2099-01-08T00:00:00.000Z');
      // Never for an environment a caller is merely evaluating.
      resetAlipaySecretlessLogForTests();
      infoSpy.mockClear();
      rail.isConfigured(go, { ALIPAY_CALLBACK_SECRET: SECRET, ALIPAY_SECRETLESS_UNTIL: '2099-01-01T00:00:00Z' });
      expect(windowLines(infoSpy)).toHaveLength(0);
    });

    it('with the variable unset the rail says nothing about a window', () => {
      vi.stubEnv('ALIPAY_SECRETLESS_UNTIL', '');
      const rail = createAlipayWorkerRail();
      rail.isConfigured({ id: 'goapply', market: 'cn' } as never, process.env);
      expect(windowLines(infoSpy)).toHaveLength(0);
      expect(windowLines(warnSpy)).toHaveLength(0);
    });
  });
});
