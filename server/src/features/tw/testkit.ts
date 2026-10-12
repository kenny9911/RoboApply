// server/src/features/tw/testkit.ts — test helpers of the Taiwan area (MKT-5F).
// Not imported by app code. No vitest import here: the file compiles with the
// server (the pattern of features/feed/testkit.ts).

import type { TwPayRuleDb } from './payRule.js';

export interface FakeAppConfig {
  db: TwPayRuleDb;
  /** The stored rows by key. */
  rows: Map<string, { value: string; updatedBy: string | null }>;
  /** Every call the code under test made, in order. */
  calls: Array<{ op: 'findUnique' | 'upsert'; key: string }>;
}

/** The AppConfig table as far as the pay rule uses it: `findUnique` and `upsert` by key, in memory. */
export function fakeAppConfig(initial: Record<string, { value: string; updatedBy?: string | null }> = {}): FakeAppConfig {
  const rows = new Map(Object.entries(initial).map(([key, row]) => [key, { value: row.value, updatedBy: row.updatedBy ?? null }]));
  const calls: FakeAppConfig['calls'] = [];
  const db = {
    appConfig: {
      async findUnique(args: { where: { key: string } }) {
        calls.push({ op: 'findUnique', key: args.where.key });
        return rows.get(args.where.key) ?? null;
      },
      async upsert(args: { where: { key: string }; update: { value: string; updatedBy: string | null }; create: { key: string; value: string; updatedBy: string | null } }) {
        calls.push({ op: 'upsert', key: args.where.key });
        const next = rows.has(args.where.key) ? args.update : args.create;
        rows.set(args.where.key, { value: next.value, updatedBy: next.updatedBy });
        return { key: args.where.key, ...rows.get(args.where.key)! };
      },
    },
  };
  return { db: db as unknown as TwPayRuleDb, rows, calls };
}
