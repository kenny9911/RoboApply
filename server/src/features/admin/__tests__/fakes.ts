// In-memory SystemStore for the admin tests (no database).

import type { SystemStore, TimeRange } from '../system.js';

export interface FakeSystemData {
  ingest: { due: number; overdue: number; failing: number };
  byDay: Array<{ day: string; count: number }>;
  open: { open: number; enriched: number };
  counters: Record<string, number>;
  queue: Awaited<ReturnType<SystemStore['queueByKind']>>;
  providers: Awaited<ReturnType<SystemStore['providerUsage']>>;
  alertEmails: { sent: number; failed: number };
  email: { sent: number; failed: number };
  failedByTemplate: Array<{ template: string; count: number }>;
  copilot: { turns: number; guardHits: number; costUsd: number };
  exhaustion: Array<{ bucket: string; count: number }> | null;
}

export function fakeSystemData(over: Partial<FakeSystemData> = {}): FakeSystemData {
  return {
    ingest: { due: 4, overdue: 1, failing: 0 },
    byDay: [],
    open: { open: 100, enriched: 80 },
    counters: {},
    queue: [
      { kind: 'job.enrich', queued: 5, leased: 1, failed: 0, dead: 2, oldestQueuedAt: '2026-10-10T10:00:00.000Z' },
      { kind: 'email.send', queued: 0, leased: 0, failed: 1, dead: 1, oldestQueuedAt: null },
    ],
    providers: [{ provider: 'jsearch', calls: 20, jobsReturned: 400, jobsNew: 50, errors: 0 }],
    alertEmails: { sent: 12, failed: 0 },
    email: { sent: 40, failed: 2 },
    failedByTemplate: [{ template: 'notify.welcome', count: 2 }],
    copilot: { turns: 9, guardHits: 1, costUsd: 0.42 },
    exhaustion: null,
    ...over,
  };
}

/** What the fake was asked for: counter windows, provider day keys and the email/Assistant ranges (ISO). */
export interface FakeSystemReads {
  counterWindows: string[];
  providerDays: string[];
  ranges: string[];
}

const rangeOf = (label: string, r: TimeRange) => `${label}:${r.since.toISOString()}..${r.until.toISOString()}`;

export function fakeSystemStore(data: FakeSystemData | ((brand: string) => FakeSystemData) = fakeSystemData()): SystemStore & { calls: string[]; reads: FakeSystemReads } {
  const calls: string[] = [];
  const reads: FakeSystemReads = { counterWindows: [], providerDays: [], ranges: [] };
  const of = (b: string) => (typeof data === 'function' ? data(b) : data);
  const marketBrand = (m: string) => (m === 'cn' ? 'goapply' : 'roboapply');
  return {
    calls,
    reads,
    ingestCounts: async (market) => (calls.push(`ingest:${market}`), of(marketBrand(market)).ingest),
    newJobsByDay: async (market) => of(marketBrand(market)).byDay,
    openJobCounts: async (market) => of(marketBrand(market)).open,
    rateCounter: async (key, windowStart) => {
      reads.counterWindows.push(windowStart.toISOString());
      return of(key.endsWith(':cn') || key.endsWith(':goapply') ? 'goapply' : 'roboapply').counters[key] ?? 0;
    },
    queueByKind: async () => of('roboapply').queue,
    providerUsage: async (dayKey) => (reads.providerDays.push(dayKey), of('roboapply').providers),
    emailStatus: async (brand, range, templates) => (reads.ranges.push(rangeOf(templates ? 'alertEmails' : 'email', range)), templates ? of(brand).alertEmails : of(brand).email),
    emailFailuresByTemplate: async (brand) => of(brand).failedByTemplate,
    copilotStats: async (brand, range) => (reads.ranges.push(rangeOf('copilot', range)), of(brand).copilot),
    creditExhaustion: async (brand, range) => (reads.ranges.push(rangeOf('exhaustion', range)), of(brand).exhaustion),
  };
}
