// @vitest-environment node
//
// FIX-9: the first page load of a new account asks for credits and the plan
// in parallel. Each request lazily creates the free SeekerSubscription row;
// the unique key on `seekerProfileId` let one of them fail with P2002
// ("Unique constraint failed on SeekerSubscription_seekerProfileId_key"),
// which the routes answered as 500.
//
// The fake database below behaves like Postgres where it matters here:
//   - `seekerProfileId` is unique (a second insert throws P2002);
//   - `upsert` is the non-atomic read-then-insert Prisma runs for it (two
//     concurrent calls both read "no row" and both insert);
//   - `createMany({ skipDuplicates })` is INSERT … ON CONFLICT DO NOTHING.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ db: null as unknown as Record<string, any> }));

vi.mock('./prisma.js', async () => {
  const { createFakePrisma } = await import('../test/fakePrisma.js');
  const db = createFakePrisma({ uniqueFields: { seekerSubscription: ['seekerProfileId'] } }) as unknown as Record<string, any>;
  const subs = db.seekerSubscription;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  subs.upsert = async (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const existing = await subs.findFirst({ where: args.where, select: args.select });
    await tick(); // the round trip between the SELECT and the INSERT
    if (existing) return existing;
    return subs.create({ data: args.create, select: args.select });
  };
  fake.db = db;
  return { default: db };
});
vi.mock('../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { adjustCredits, getBalance, grantForPlanIfNewPeriod } from './mockCreditService.js';

const NOW = new Date('2026-10-10T08:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('LLM_SETTINGS_DB_DISABLED', 'true');
  for (const t of ['seekerProfile', 'seekerSubscription', 'mockInterviewCreditLedger', 'rACreditGrant']) fake.db[t].deleteMany({});
  fake.db.seekerProfile.create({ data: { id: 'sp_new', userId: 'u_new' } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('first requests of a new account (no SeekerSubscription row yet)', () => {
  it('parallel balance reads all succeed, create one free row and grant the sign-up credit once', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => getBalance('u_new')));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    for (const r of results) {
      expect((r as PromiseFulfilledResult<Awaited<ReturnType<typeof getBalance>>>).value).toMatchObject({ credits: 1, tier: 'free', ephemeral: false });
    }
    const subs = await fake.db.seekerSubscription.findMany({});
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ seekerProfileId: 'sp_new', tier: 'free', status: 'active', mockCredits: 1 });
    const ledger = await fake.db.mockInterviewCreditLedger.findMany({});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ reason: 'signup_bonus', balanceAfter: 1 });
  });

  it('a balance read racing a plan grant and a credit adjustment does not fail either', async () => {
    const [balance, granted, adjusted] = await Promise.allSettled([
      getBalance('u_new'),
      grantForPlanIfNewPeriod({ userId: 'u_new', tier: 'pro', credits: 3, periodStart: NOW, source: 'stripe', force: true }),
      adjustCredits({ userId: 'u_new', delta: 1, reason: 'admin_adjust', source: 'system' }),
    ]);
    expect(balance.status).toBe('fulfilled');
    expect(granted).toEqual({ status: 'fulfilled', value: 'granted' });
    expect(adjusted.status).toBe('fulfilled');
    expect(await fake.db.seekerSubscription.findMany({})).toHaveLength(1);
  });

  it('an account that already has a row is read without writing', async () => {
    fake.db.seekerSubscription.create({ data: { id: 'sub_1', seekerProfileId: 'sp_new', tier: 'free', status: 'active', mockCredits: 0.5, mockCreditsRenewedAt: NOW } });
    const createMany = vi.spyOn(fake.db.seekerSubscription, 'createMany');
    const upsert = vi.spyOn(fake.db.seekerSubscription, 'upsert');
    expect(await getBalance('u_new')).toMatchObject({ credits: 0.5, tier: 'free' });
    expect(createMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    createMany.mockRestore();
    upsert.mockRestore();
  });

  it('no seeker profile: a virtual free balance and nothing is created', async () => {
    expect(await getBalance('u_none')).toMatchObject({ credits: 1, tier: 'free', ephemeral: true });
    expect(await fake.db.seekerSubscription.findMany({})).toHaveLength(0);
  });
});
