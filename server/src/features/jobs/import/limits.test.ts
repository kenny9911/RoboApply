// @vitest-environment node
//
// WP-35 — import limits persisted in RARateCounter: 20 consecutive failures →
// 1 h lock; the 3rd lock in 7 days → 7-day lock; a success resets the run;
// the hourly limit uses the platform limiter key.

import { describe, expect, it, vi } from 'vitest';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import { IMPORT_LIMITS } from './contract.js';
import { createImportLimitStore, type CounterDelegate } from './limits.js';

const T0 = new Date('2026-10-10T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const fake = createFakePrisma();
  const consume = vi.fn(async () => ({ allowed: true, retryAfterSec: 0, remaining: 9, windows: [] }));
  const store = createImportLimitStore({ counters: fake.rARateCounter as unknown as CounterDelegate, consume, brandId: 'roboapply' });
  return { fake, store, consume };
}

async function fail(store: ReturnType<typeof setup>['store'], n: number, at: Date) {
  let last = null as Awaited<ReturnType<typeof store.recordFailure>> | null;
  for (let i = 0; i < n; i += 1) last = await store.recordFailure('u1', at);
  return last!;
}

describe('createImportLimitStore', () => {
  it('locks for an hour after 20 consecutive failures, persisted as counter rows', async () => {
    const { fake, store } = setup();
    const r19 = await fail(store, IMPORT_LIMITS.failuresBeforeLock - 1, T0);
    expect(r19).toMatchObject({ consecutive: 19, lockedUntil: null });
    expect(await store.activeLock('u1', T0)).toBeNull();

    const r20 = await store.recordFailure('u1', T0);
    expect(r20.lockedUntil?.toISOString()).toBe(new Date(T0.getTime() + HOUR).toISOString());
    expect(r20.longLock).toBe(false);
    expect((await store.activeLock('u1', new Date(T0.getTime() + 30 * 60_000)))?.getTime()).toBe(T0.getTime() + HOUR);
    expect(await store.activeLock('u1', new Date(T0.getTime() + HOUR + 1))).toBeNull();
    expect(await store.activeLock('u2', T0)).toBeNull();

    const keys = fake.$rows('rARateCounter').map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['rl:roboapply:jobImportLock:user:u1', 'rl:roboapply:jobImportLockLog:user:u1']));
    // The failure run restarts after a lock.
    expect(keys).not.toContain('rl:roboapply:jobImportFailures:user:u1');
  });

  it('a success resets the consecutive count', async () => {
    const { store } = setup();
    await fail(store, 15, T0);
    await store.recordSuccess('u1');
    const r = await fail(store, 15, T0);
    expect(r).toMatchObject({ consecutive: 15, lockedUntil: null });
  });

  it('the third lock within 7 days lasts 7 days', async () => {
    const { store } = setup();
    const first = await fail(store, 20, T0);
    expect(first.longLock).toBe(false);
    const t1 = new Date(T0.getTime() + 2 * DAY);
    const second = await fail(store, 20, t1);
    expect(second.longLock).toBe(false);
    const t2 = new Date(T0.getTime() + 5 * DAY);
    const third = await fail(store, 20, t2);
    expect(third.longLock).toBe(true);
    expect(third.lockedUntil?.getTime()).toBe(t2.getTime() + 7 * DAY);
    expect((await store.activeLock('u1', new Date(t2.getTime() + 6 * DAY)))?.getTime()).toBe(t2.getTime() + 7 * DAY);
  });

  it('locks older than 7 days do not count towards the long lock', async () => {
    const { store } = setup();
    await fail(store, 20, T0);
    await fail(store, 20, new Date(T0.getTime() + DAY));
    const later = new Date(T0.getTime() + 9 * DAY);
    const r = await fail(store, 20, later);
    expect(r.longLock).toBe(false);
  });

  it('counts the hourly limit under the jobImportPerUser key', async () => {
    const { store, consume } = setup();
    await store.consumeHourly('u1', T0);
    expect(consume).toHaveBeenCalledWith('rl:roboapply:jobImportPerUser:user:u1', T0);
  });

  it('a draft nonce can be claimed once per user (persisted until the draft expires)', async () => {
    const { fake, store } = setup();
    const exp = new Date(T0.getTime() + 2 * HOUR);
    expect(await store.claimDraft('u1', 'nonce-aaaa', exp)).toBe(true);
    expect(await store.claimDraft('u1', 'nonce-aaaa', exp)).toBe(false);
    expect(await store.claimDraft('u1', 'nonce-bbbb', exp)).toBe(true);
    expect(await store.claimDraft('u2', 'nonce-aaaa', exp)).toBe(true);
    const row = fake.$rows('rARateCounter').find((r) => r.key === 'rl:roboapply:jobImportDraftUsed:user:u1:nonce-aaaa');
    expect(row?.expiresAt).toEqual(exp);
  });

  it('a concurrent claim that loses the insert race (P2002) is not a claim', async () => {
    const counters = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }),
    } as unknown as CounterDelegate;
    const store = createImportLimitStore({ counters, consume: vi.fn(), brandId: 'roboapply' });
    expect(await store.claimDraft('u1', 'nonce-aaaa', T0)).toBe(false);
  });
});
