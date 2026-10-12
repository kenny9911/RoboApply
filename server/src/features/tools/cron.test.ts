// @vitest-environment node
//
// WP-57: the 24 h purge (jobs-maintain) deletes only the brand's expired
// tool results and reports what it did; nothing due → returns at once.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { getBrand } from '../../platform/brand/registry.js';
import { createBudget } from '../../platform/queue/index.js';
import { createToolsPurge, runToolsPurge } from './cron.js';
import { createMemoryToolsStore } from './memoryStore.js';
import type { ToolResultPayload } from './store.js';

const payload: ToolResultPayload = {
  v: 1,
  tool: 'resume_check',
  cacheKey: 'k',
  report: { kind: 'resume_check', label: 'fair', counts: { urgent: 0, critical: 1, optional: 0 }, issues: [], rulesChecked: 10, profile: 'intl' },
  resume: { markdown: '# A', name: 'a' },
};

describe('runToolsPurge', () => {
  it('is a cron task', () => {
    expect(typeof runToolsPurge).toBe('function');
  });

  it('deletes expired rows of the cron brand only', async () => {
    const store = createMemoryToolsStore();
    const now = new Date('2026-10-11T03:30:00.000Z');
    await store.create({ brand: 'roboapply', tokenHash: 'h1', payload, expiresAt: new Date(now.getTime() - 1) });
    await store.create({ brand: 'roboapply', tokenHash: 'h2', payload, expiresAt: new Date(now.getTime() + 3600_000) });
    await store.create({ brand: 'goapply', tokenHash: 'h3', payload, expiresAt: new Date(now.getTime() - 1) });
    const task = createToolsPurge(() => store);
    const ctx = { name: 'jobs-maintain', brand: getBrand('roboapply'), budget: createBudget(10_000), now };
    expect(await task(ctx)).toEqual({ processed: 1 });
    expect(store.rows.map((r) => r.tokenHash).sort()).toEqual(['h2', 'h3']);
    expect(await task(ctx)).toEqual({ skipped: 'no_work', processed: 0 });
  });
});
