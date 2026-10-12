// @vitest-environment node
//
// WP-78 logged-out alerts (F-NOTIF-03): double opt-in, no enumeration, abuse
// limits, confirm links (read without change, confirm idempotently, brand and
// expiry checks), one-click unsubscribe with the platform token.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { createUnsubscribeToken, hashEmail } from '../../platform/email/unsubscribe.js';
import { filtersKey, maskEmail, searchLabel, sha256, VisitorAlertsService, type VisitorRate } from './alerts.js';
import { createMemoryVisitorAlertsRepo } from './testkit.js';
import { createAnonAlertDigestTask } from './digest.js';
import { createBudget } from '../../platform/queue/index.js';

const ROBO = getBrand('roboapply');
const GO = getBrand('goapply');
const NOW = new Date('2026-10-10T08:00:00.000Z');
const ENV = { EMAIL_UNSUBSCRIBE_SECRET: 'test-secret' };
const H = 3_600_000;

function setup(opts: { ipLimit?: number; emailLimit?: number } = {}) {
  const repo = createMemoryVisitorAlertsRepo(() => NOW);
  const counts = new Map<string, number>();
  const rate: VisitorRate = {
    async consume(name, _scope, id, windows) {
      const k = `${name}|${id}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      const limit = name === 'visitorAlertSignupPerIp' ? (opts.ipLimit ?? windows[0]!.limit) : (opts.emailLimit ?? windows[0]!.limit);
      return { allowed: n <= limit, retryAfterSec: n <= limit ? 0 : 3600 };
    },
  };
  const sendConfirm = vi.fn(async () => ({ status: 'sent' as const }));
  let tok = 0;
  const svc = new VisitorAlertsService({
    repo,
    rate,
    sendConfirm,
    origin: (b) => (b.id === 'goapply' ? 'https://www.goapply.top' : 'https://www.roboapply.io'),
    now: () => NOW,
    env: ENV,
    newToken: () => `token-${++tok}-abcdefghijklmnop`,
  });
  return { repo, svc, sendConfirm };
}

const input = { email: 'Jane.Doe@Example.com', filters: { q: 'Data analyst', locations: [{ label: 'Taipei', city: 'Taipei', country: 'TW' }] }, frequency: 'weekly' as const, locale: 'zh-TW' };

describe('create (double opt-in)', () => {
  it('stores a pending row, a hashed 72 h token, and emails the confirm link', async () => {
    const { repo, svc, sendConfirm } = setup();
    expect(await svc.create(input, { brand: ROBO, ip: '1.1.1.1' })).toEqual({ status: 'pending_confirmation' });
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ status: 'pending', email: 'jane.doe@example.com', emailHash: hashEmail('jane.doe@example.com'), locale: 'zh-TW', cadence: 'weekly', brand: 'roboapply' });
    expect(repo.tokens[0]!.tokenHash).toBe(sha256('token-1-abcdefghijklmnop'));
    expect(repo.tokens[0]!.expiresAt.getTime() - NOW.getTime()).toBe(72 * 3_600_000);
    expect(sendConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane.doe@example.com',
        locale: 'zh-TW',
        params: { url: 'https://www.roboapply.io/alerts/confirm/token-1-abcdefghijklmnop', search: 'Data analyst · Taipei', cadence: 'weekly', hours: 72 },
      }),
    );
  });

  it('clamps the locale to the brand (GoApply has zh and en only)', async () => {
    const { repo, svc } = setup();
    await svc.create({ ...input, locale: 'ja' }, { brand: GO, ip: '1.1.1.1' });
    expect(repo.rows[0]!.locale).toBe('zh');
  });

  it('answers the same for an address that already has the alert, and sends nothing new', async () => {
    const { repo, svc, sendConfirm } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    repo.rows[0]!.status = 'confirmed';
    sendConfirm.mockClear();
    expect(await svc.create({ ...input, frequency: 'daily' }, { brand: ROBO, ip: '2.2.2.2' })).toEqual({ status: 'pending_confirmation' });
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(1);
    // Anyone can type the address: a confirmed alert's cadence and language are not changed by a sign-up.
    expect(repo.rows[0]).toMatchObject({ cadence: 'weekly', locale: 'zh-TW' });
    await svc.create({ ...input, locale: 'en' }, { brand: ROBO, ip: '3.3.3.3' });
    expect(repo.rows[0]).toMatchObject({ cadence: 'weekly', locale: 'zh-TW' });
  });

  it('re-sends the link for the same pending alert instead of adding a row', async () => {
    const { repo, svc, sendConfirm } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    expect(repo.rows).toHaveLength(1);
    expect(repo.tokens).toHaveLength(2);
    expect(sendConfirm).toHaveBeenCalledTimes(2);
  });

  it('a link re-sent at hour 60 still confirms at hour 100: the re-send restarts the 72 h purge clock', async () => {
    let clock = NOW;
    const repo = createMemoryVisitorAlertsRepo(() => clock);
    let tok = 0;
    const svc = new VisitorAlertsService({
      repo,
      rate: { consume: async () => ({ allowed: true, retryAfterSec: 0 }) },
      sendConfirm: vi.fn(async () => ({ status: 'sent' as const })),
      origin: () => 'https://www.roboapply.io',
      now: () => clock,
      env: ENV,
      newToken: () => `token-${++tok}-abcdefghijklmnop`,
    });
    const task = createAnonAlertDigestTask({ repo, alertsEnabled: async () => true, send: vi.fn(), origin: () => 'https://www.roboapply.io' });
    const cron = () => task({ name: 'job-alerts', brand: ROBO, now: clock, budget: createBudget(240_000) });
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    clock = new Date(NOW.getTime() + 60 * H);
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    expect(repo.rows[0]!.createdAt).toEqual(clock);
    clock = new Date(NOW.getTime() + 73 * H);
    await cron();
    expect(repo.rows).toHaveLength(1);
    clock = new Date(NOW.getTime() + 100 * H);
    await cron();
    expect((await svc.confirm('token-2-abcdefghijklmnop', ROBO)).state).toBe('confirmed');
    // The first link expired at hour 72 as it said.
    const old = await svc.preview('token-1-abcdefghijklmnop', ROBO).catch((e) => e);
    expect(old).toBeInstanceOf(HttpError);
  });

  it('a pending sign-up nobody re-sent is purged 72 h after its link', async () => {
    let clock = NOW;
    const repo = createMemoryVisitorAlertsRepo(() => clock);
    const svc = new VisitorAlertsService({
      repo,
      rate: { consume: async () => ({ allowed: true, retryAfterSec: 0 }) },
      sendConfirm: vi.fn(async () => ({ status: 'sent' as const })),
      origin: () => 'https://www.roboapply.io',
      now: () => clock,
      env: ENV,
    });
    const task = createAnonAlertDigestTask({ repo, alertsEnabled: async () => true, send: vi.fn(), origin: () => 'https://www.roboapply.io' });
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    clock = new Date(NOW.getTime() + 73 * H);
    await task({ name: 'job-alerts', brand: ROBO, now: clock, budget: createBudget(240_000) });
    expect(repo.rows).toHaveLength(0);
  });

  it('limits sign-ups per IP with 429 + Retry-After', async () => {
    const { svc } = setup({ ipLimit: 1 });
    await svc.create(input, { brand: ROBO, ip: '9.9.9.9' });
    const err = await svc.create({ ...input, email: 'other@example.com' }, { brand: ROBO, ip: '9.9.9.9' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe('rate_limited');
    expect(err.headers).toEqual({ 'Retry-After': '3600' });
  });

  it('protects an inbox: past 3 confirm emails a day it still answers 202 but sends nothing', async () => {
    const { svc, sendConfirm } = setup({ emailLimit: 3 });
    for (let i = 0; i < 5; i += 1) {
      expect(await svc.create({ ...input, filters: { q: `role ${i}` } }, { brand: ROBO, ip: `10.0.0.${i}` })).toEqual({ status: 'pending_confirmation' });
    }
    expect(sendConfirm).toHaveBeenCalledTimes(3);
  });

  it('caps live alerts per address at 5 (silently)', async () => {
    const { repo, svc, sendConfirm } = setup({ emailLimit: 100 });
    for (let i = 0; i < 7; i += 1) await svc.create({ ...input, filters: { q: `role ${i}` } }, { brand: ROBO, ip: `10.0.0.${i}` });
    expect(repo.rows).toHaveLength(5);
    expect(sendConfirm).toHaveBeenCalledTimes(5);
  });
});

describe('confirm links', () => {
  it('preview changes nothing; confirm marks it confirmed and consumes the token; repeat is idempotent', async () => {
    const { repo, svc } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    const token = 'token-1-abcdefghijklmnop';
    const view = await svc.preview(token, ROBO);
    expect(view).toEqual({ state: 'pending', cadence: 'weekly', filters: input.filters, emailMasked: 'j•••@example.com' });
    expect(repo.rows[0]!.status).toBe('pending');
    expect((await svc.confirm(token, ROBO)).state).toBe('confirmed');
    expect(repo.rows[0]!.confirmedAt).toEqual(NOW);
    expect(repo.tokens[0]!.consumedAt).toEqual(NOW);
    expect((await svc.confirm(token, ROBO)).state).toBe('confirmed');
    expect((await svc.preview(token, ROBO)).state).toBe('confirmed');
  });

  it('rejects unknown, other-brand and expired links with 404 alert_token_invalid', async () => {
    const { repo, svc } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    const bad = async (p: Promise<unknown>) => {
      const e = (await p.catch((x) => x)) as HttpError;
      expect(e).toBeInstanceOf(HttpError);
      expect(e.code).toBe('not_found');
      expect(e.details).toEqual({ reason: 'alert_token_invalid' });
    };
    await bad(svc.preview('nope-nope-nope-nope', ROBO));
    await bad(svc.confirm('token-1-abcdefghijklmnop', GO));
    repo.tokens[0]!.expiresAt = new Date(NOW.getTime() - 1);
    await bad(svc.confirm('token-1-abcdefghijklmnop', ROBO));
    expect(repo.rows[0]!.status).toBe('pending');
  });

  it('an old link does not put back an address that left', async () => {
    const { repo, svc } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    repo.rows[0]!.status = 'unsubscribed';
    expect((await svc.confirm('token-1-abcdefghijklmnop', ROBO)).state).toBe('unsubscribed');
    expect(repo.rows[0]!.status).toBe('unsubscribed');
  });
});

describe('unsubscribe', () => {
  it('one click with the email token stops every live alert of the address on this brand only', async () => {
    const { repo, svc } = setup();
    await svc.create(input, { brand: ROBO, ip: '1.1.1.1' });
    await svc.create({ ...input, filters: { q: 'designer' } }, { brand: ROBO, ip: '1.1.1.1' });
    await svc.create(input, { brand: GO, ip: '1.1.1.1' });
    const token = createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', email: 'jane.doe@example.com', env: ENV });
    expect(await svc.unsubscribe(token, ROBO)).toEqual({ unsubscribed: true });
    expect(repo.rows.filter((r) => r.brand === 'roboapply').map((r) => r.status)).toEqual(['unsubscribed', 'unsubscribed']);
    expect(repo.rows.find((r) => r.brand === 'goapply')!.status).toBe('pending');
  });

  it('refuses tokens for accounts, other lists, other brands and forgeries', async () => {
    const { svc } = setup();
    const cases = [
      createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', userId: 'u1', env: ENV }),
      createUnsubscribeToken({ brand: 'roboapply', list: 'marketing', email: 'a@b.co', env: ENV }),
      createUnsubscribeToken({ brand: 'goapply', list: 'alerts', email: 'a@b.co', env: ENV }),
      createUnsubscribeToken({ brand: 'roboapply', list: 'alerts', email: 'a@b.co', env: { EMAIL_UNSUBSCRIBE_SECRET: 'other' } }),
    ];
    for (const t of cases) {
      const e = await svc.unsubscribe(t, ROBO).catch((x) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).code).toBe('not_found');
    }
  });
});

describe('helpers', () => {
  it('masks addresses, labels searches and compares filters ignoring order and case', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
    expect(searchLabel({})).toBe('');
    expect(searchLabel({ country: 'TW' })).toBe('TW');
    expect(searchLabel({ q: ' Nurse ', locations: [{ label: 'Taichung' }] })).toBe('Nurse · Taichung');
    // Typed text cannot carry a link or an address into the email.
    expect(searchLabel({ q: 'Claim now https://evil.example/x www.evil.example mail me@evil.example' })).toBe('Claim now mail me evil.example');
    expect(searchLabel({ q: 'Node.js / C# developer' })).toBe('Node.js / C# developer');
    expect(searchLabel({ q: 'see evil.example/claim now' })).toBe('see now');
    expect(searchLabel({ q: 'https://evil.example', locations: [{ label: 'Taipei' }] })).toBe('Taipei');
    expect(filtersKey({ q: 'Data', workModels: ['remote', 'hybrid'] })).toBe(filtersKey({ workModels: ['hybrid', 'remote'], q: 'data' }));
    expect(filtersKey({ q: 'Data' })).not.toBe(filtersKey({ q: 'Data', country: 'US' }));
  });
});
