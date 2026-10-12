// server/src/platform/credits/testkit.ts
//
// Builders for tests that need a working credit stack without a database:
// a memory store plus an entitlement service over a fixed account. Later WPs
// use it to test `withCredit` call sites (e.g. "zero LLM calls when credits
// are exhausted"). No vitest imports.

import type { BrandId } from '../brand/registry.js';
import { DEFAULT_CREDIT_CATALOG, type CreditCatalog } from './catalog.js';
import { createCreditService, type CreditService, type DeductionLogWriter } from './CreditService.js';
import { createEntitlementService, type AccountSnapshot, type EntitlementOverrideRow, type EntitlementService } from './EntitlementService.js';
import { createMemoryCreditStore, type MemoryCreditStore, type MemoryGrant } from './memoryStore.js';

export interface CreditTestKit {
  store: MemoryCreditStore;
  entitlements: EntitlementService;
  credits: CreditService;
  /** Change the clock used by both services. */
  setNow(date: Date): void;
  /** Replace the account the entitlement service sees (plan changes). */
  setAccount(userId: string, account: AccountSnapshot | null): void;
  setOverrides(userId: string, rows: EntitlementOverrideRow[]): void;
  deductionLogs: Parameters<DeductionLogWriter>[0][];
}

export function createCreditTestKit(
  options: {
    accounts?: Record<string, AccountSnapshot | null>;
    overrides?: Record<string, EntitlementOverrideRow[]>;
    grants?: Partial<MemoryGrant>[];
    now?: Date;
    proSellable?: boolean;
    catalog?: Partial<Record<BrandId, CreditCatalog>>;
  } = {},
): CreditTestKit {
  let now = options.now ?? new Date('2026-10-10T12:00:00Z');
  const accounts = new Map(Object.entries(options.accounts ?? {}));
  const overrides = new Map(Object.entries(options.overrides ?? {}));
  const store = createMemoryCreditStore({ grants: options.grants });
  const deductionLogs: Parameters<DeductionLogWriter>[0][] = [];
  const entitlements = createEntitlementService({
    source: {
      loadAccount: async (userId) => accounts.get(userId) ?? { brand: 'roboapply', timezone: null, subscription: null },
      loadOverrides: async (userId) => overrides.get(userId) ?? [],
    },
    loadCatalog: async (brand) => options.catalog?.[brand] ?? DEFAULT_CREDIT_CATALOG[brand],
    proSellable: () => options.proSellable ?? true,
    now: () => now,
    memoTtlMs: 0,
  });
  const credits = createCreditService({
    store,
    entitlements,
    now: () => now,
    writeDeductionLog: async (row) => {
      deductionLogs.push(row);
    },
  });
  return {
    store,
    entitlements,
    credits,
    setNow: (d) => {
      now = d;
    },
    setAccount: (userId, account) => {
      accounts.set(userId, account);
    },
    setOverrides: (userId, rows) => {
      overrides.set(userId, rows);
    },
    deductionLogs,
  };
}
