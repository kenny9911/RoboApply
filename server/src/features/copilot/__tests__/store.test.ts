// @vitest-environment node
// The Assistant's writes on a busy database (verification finding, 2026-10-10:
// "Unable to start a transaction in the given time" lost a whole turn and left
// an applied proposal's card unchanged): longer waits than Prisma's defaults
// and another try when the transaction never started.

import { describe, expect, it, vi } from 'vitest';

import { COPILOT_TX_ATTEMPTS, COPILOT_TX_OPTIONS, createPrismaCopilotStore, isTransientDbError, retryTransient } from '../store.js';
import { makeFake, USER } from './testkit.js';

const cannotStart = () => Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });

/** A database whose next `failures` transactions cannot start; records the options each one was opened with. */
function busyDb(failures: number) {
  const db = makeFake();
  const state = { left: failures, calls: 0, options: [] as unknown[] };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') {
        return async (fn: unknown, options?: unknown) => {
          state.calls += 1;
          state.options.push(options);
          if (state.left > 0) {
            state.left -= 1;
            throw cannotStart();
          }
          return (target.$transaction as (f: unknown) => Promise<unknown>)(fn);
        };
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  });
  return { db, proxy, state };
}

const turn = (threadId: string) => ({
  threadId,
  user: { content: 'hi', createdAt: new Date('2026-10-10T10:00:00Z') },
  assistant: { id: 'msg_1', content: 'Hello.', cards: [], toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, createdAt: new Date('2026-10-10T10:00:01Z') },
  costUsd: 0,
  title: 'hi',
  contextJobId: null,
});

describe('isTransientDbError', () => {
  it('knows the errors that left nothing written', () => {
    expect(isTransientDbError(cannotStart())).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('pool'), { code: 'P2024' }))).toBe(true);
    expect(isTransientDbError(new Error('Timed out fetching a new connection from the connection pool.'))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))).toBe(false);
    expect(isTransientDbError(new Error('db down'))).toBe(false);
  });
});

describe('retryTransient', () => {
  it('tries again only for a transient error, at most the given number of times', async () => {
    const sleep = vi.fn(async () => undefined);
    const flaky = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw cannotStart();
      return 'ok';
    });
    expect(await retryTransient(flaky, { sleep })).toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const never = vi.fn(async () => {
      throw cannotStart();
    });
    await expect(retryTransient(never, { sleep })).rejects.toMatchObject({ code: 'P2028' });
    expect(never).toHaveBeenCalledTimes(COPILOT_TX_ATTEMPTS);

    const fatal = vi.fn(async () => {
      throw new Error('syntax error');
    });
    await expect(retryTransient(fatal, { sleep })).rejects.toThrow('syntax error');
    expect(fatal).toHaveBeenCalledTimes(1);
  });
});

describe('store writes on a busy database', () => {
  it('saveTurn waits longer than the defaults and saves on the next try', async () => {
    const { db, proxy, state } = busyDb(2);
    const store = createPrismaCopilotStore(async () => proxy as never, { sleep: async () => undefined });
    const thread = await store.createThread({ userId: USER, brand: 'roboapply', contextJobId: null });
    const out = await store.saveTurn(turn(thread.id));
    expect(out.messageCount).toBe(2);
    expect(state.calls).toBe(3);
    expect(state.options.every((o) => o === COPILOT_TX_OPTIONS)).toBe(true);
    expect(COPILOT_TX_OPTIONS.maxWait).toBeGreaterThan(2_000);
    expect(await db.rACopilotMessage.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it('saveTurn never stores a turn twice when a try was committed but its answer was lost', async () => {
    const db = makeFake();
    let lose = true;
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (fn: unknown) => {
            const res = await (target.$transaction as (f: unknown) => Promise<unknown>)(fn);
            if (lose) {
              lose = false;
              throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1017' });
            }
            return res;
          };
        }
        return (target as Record<string | symbol, unknown>)[prop];
      },
    });
    const store = createPrismaCopilotStore(async () => proxy as never, { sleep: async () => undefined });
    const thread = await store.createThread({ userId: USER, brand: 'roboapply', contextJobId: null });
    expect((await store.saveTurn(turn(thread.id))).messageCount).toBe(2);
    expect(await db.rACopilotMessage.count({ where: { threadId: thread.id } })).toBe(2);
  });

  it('saveTurn gives up after the last try', async () => {
    const { proxy, state } = busyDb(99);
    const store = createPrismaCopilotStore(async () => proxy as never, { sleep: async () => undefined });
    const thread = await store.createThread({ userId: USER, brand: 'roboapply', contextJobId: null });
    await expect(store.saveTurn(turn(thread.id))).rejects.toMatchObject({ code: 'P2028' });
    expect(state.calls).toBe(COPILOT_TX_ATTEMPTS);
  });

  it('updateCards is tried again, so an applied proposal reaches its card', async () => {
    const { db, proxy, state } = busyDb(0);
    const store = createPrismaCopilotStore(async () => proxy as never, { sleep: async () => undefined });
    const thread = await store.createThread({ userId: USER, brand: 'roboapply', contextJobId: null });
    await store.saveTurn({ ...turn(thread.id), assistant: { ...turn(thread.id).assistant, cards: [{ type: 'filter_diff', id: 'c1', data: { proposalId: 'p1', status: 'pending' } }] } });
    state.left = 1;
    await store.updateCards('msg_1', (cards) => cards.map((c) => ({ ...c, data: { ...(c.data as object), status: 'applied' } })));
    const row = (await db.rACopilotMessage.findMany({ where: { id: 'msg_1' } }))[0] as { cards: Array<{ data: { status: string } }> };
    expect(row.cards[0]!.data.status).toBe('applied');
  });
});
