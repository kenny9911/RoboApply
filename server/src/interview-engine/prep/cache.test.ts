// @vitest-environment node
//
// The prep agents' in-process cache (prep/cache.ts): TTL on an injected
// clock, LRU eviction, one shared computation per missing key, and values a
// caller does not want remembered (a failed research) are not.
// Run: npx vitest run server/src/interview-engine/prep/cache.test.ts

import { describe, expect, it, vi } from 'vitest';
import { createTtlCache, keyPart } from './cache.js';

describe('createTtlCache', () => {
  it('expires an entry at its TTL (counted from the write, not the reads) and forgets it', () => {
    let now = 1_000;
    const cache = createTtlCache<string>({ ttlMs: 500, max: 10, now: () => now });
    cache.set('a', 'A');
    now += 250;
    expect(cache.get('a')).toBe('A');
    now += 249;
    expect(cache.get('a')).toBe('A');
    now += 1; // exactly the TTL after the write
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('a new write restarts the TTL', () => {
    let now = 0;
    const cache = createTtlCache<number>({ ttlMs: 100, max: 10, now: () => now });
    cache.set('k', 1);
    now = 90;
    cache.set('k', 2);
    now = 150;
    expect(cache.get('k')).toBe(2);
    now = 190;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond max; a read counts as a use', () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    // Overwriting moves an entry to the front too.
    cache.set('a', 10);
    cache.set('d', 4);
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
  });

  it('getOrCompute shares one computation between concurrent callers, then serves the cache', async () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000, max: 10 });
    let release: (value: string) => void = () => undefined;
    const compute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = cache.getOrCompute('k', compute);
    const second = cache.getOrCompute('k', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    release('V');
    await expect(Promise.all([first, second])).resolves.toEqual(['V', 'V']);
    await expect(cache.getOrCompute('k', compute)).resolves.toBe('V');
    expect(compute).toHaveBeenCalledTimes(1);
    // Another key is its own computation.
    const other = vi.fn(async () => 'W');
    await expect(cache.getOrCompute('other', other)).resolves.toBe('W');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('a value cacheIf rejects is returned but not remembered', async () => {
    const cache = createTtlCache<string | null>({ ttlMs: 60_000, max: 10 });
    const compute = vi.fn(async () => null);
    const options = { cacheIf: (value: string | null) => value !== null };
    await expect(cache.getOrCompute('k', compute, options)).resolves.toBeNull();
    await expect(cache.getOrCompute('k', compute, options)).resolves.toBeNull();
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    // An accepted value is remembered.
    compute.mockResolvedValueOnce('found');
    await expect(cache.getOrCompute('k', compute, options)).resolves.toBe('found');
    await expect(cache.getOrCompute('k', compute, options)).resolves.toBe('found');
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('a failed computation reaches every concurrent caller, is not cached, and runs again next time', async () => {
    const cache = createTtlCache<string>({ ttlMs: 60_000, max: 10 });
    const compute = vi.fn(async () => {
      throw new Error('model down');
    });
    const calls = [cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)];
    await expect(calls[0]).rejects.toThrow('model down');
    await expect(calls[1]).rejects.toThrow('model down');
    expect(compute).toHaveBeenCalledTimes(1);
    compute.mockResolvedValueOnce('recovered');
    await expect(cache.getOrCompute('k', compute)).resolves.toBe('recovered');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('an expired entry is computed again', async () => {
    let now = 0;
    const cache = createTtlCache<number>({ ttlMs: 1_000, max: 10, now: () => now });
    let n = 0;
    const compute = vi.fn(async () => ++n);
    await expect(cache.getOrCompute('k', compute)).resolves.toBe(1);
    now = 999;
    await expect(cache.getOrCompute('k', compute)).resolves.toBe(1);
    now = 1_000;
    await expect(cache.getOrCompute('k', compute)).resolves.toBe(2);
  });

  it('clear() empties it', () => {
    const cache = createTtlCache<number>({ ttlMs: 60_000, max: 10 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('keyPart', () => {
  it('normalizes width and case, single-spaces, trims and caps', () => {
    expect(keyPart('  ACME   Corp ')).toBe('acme corp');
    expect(keyPart('ＡＣＭＥ　ＡＩ')).toBe('acme ai');
    expect(keyPart('x'.repeat(300))).toHaveLength(120);
    expect(keyPart('abcdef', 3)).toBe('abc');
    expect(keyPart(null)).toBe('');
    expect(keyPart(undefined)).toBe('');
  });
});
