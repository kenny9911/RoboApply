// server/src/features/visitor/testkit.ts — in-memory VisitorAlertsRepo for tests (WP-78).
// No vitest imports: compiles with the server like every area testkit.

import type { AlertJobRow, AnonAlertRow, ConfirmTokenRow, NewJobsQuery, VisitorAlertsRepo } from './repo.js';

export interface MemoryVisitorAlertsRepo extends VisitorAlertsRepo {
  rows: AnonAlertRow[];
  tokens: Array<ConfirmTokenRow & { tokenHash: string }>;
  /** Jobs `newJobs` answers from (filters are not applied: tests set what matches). */
  jobs: Array<AlertJobRow & { firstSeenAt: Date }>;
  newJobsCalls: NewJobsQuery[];
}

export function createMemoryVisitorAlertsRepo(now: () => Date = () => new Date()): MemoryVisitorAlertsRepo {
  let seq = 0;
  const repo: MemoryVisitorAlertsRepo = {
    rows: [],
    tokens: [],
    jobs: [],
    newJobsCalls: [],
    async liveByEmail(brand, emailHash) {
      return repo.rows.filter((r) => r.brand === brand && r.emailHash === emailHash && (r.status === 'pending' || r.status === 'confirmed'));
    },
    async create(data) {
      const row: AnonAlertRow = {
        id: `sub_${++seq}`,
        brand: data.brand,
        email: data.email,
        emailHash: data.emailHash,
        locale: data.locale,
        filters: data.filters,
        cadence: data.cadence,
        status: 'pending',
        confirmedAt: null,
        unsubscribedAt: null,
        lastSentAt: null,
        createdAt: now(),
      };
      repo.rows.push(row);
      return row;
    },
    async update(id, data) {
      const row = repo.rows.find((r) => r.id === id);
      if (row) Object.assign(row, data);
    },
    async find(id) {
      return repo.rows.find((r) => r.id === id) ?? null;
    },
    async createToken({ brand, tokenHash, subscriptionId, expiresAt }) {
      repo.tokens.push({ id: `tok_${++seq}`, brand, kind: 'anon_alert_confirm', tokenHash, payload: { subscriptionId }, expiresAt, consumedAt: null });
    },
    async findToken(tokenHash) {
      return repo.tokens.find((t) => t.tokenHash === tokenHash) ?? null;
    },
    async consumeToken(id, at) {
      const t = repo.tokens.find((x) => x.id === id);
      if (t && !t.consumedAt) t.consumedAt = at;
    },
    async unsubscribeByEmailHash(brand, emailHash, at) {
      let n = 0;
      for (const r of repo.rows) {
        if (r.brand === brand && r.emailHash === emailHash && r.status !== 'unsubscribed') {
          r.status = 'unsubscribed';
          r.unsubscribedAt = at;
          n += 1;
        }
      }
      return n;
    },
    async due(brand, cut, limit) {
      return repo.rows
        .filter((r) => {
          if (r.brand !== brand || r.status !== 'confirmed') return false;
          const from = r.lastSentAt ?? r.confirmedAt;
          if (!from) return false;
          return from.getTime() <= (r.cadence === 'daily' ? cut.daily : cut.weekly).getTime();
        })
        .sort((a, b) => (a.lastSentAt?.getTime() ?? 0) - (b.lastSentAt?.getTime() ?? 0))
        .slice(0, limit);
    },
    async purge(brand, cut) {
      const before = repo.rows.length;
      const pending = repo.rows.filter((r) => r.brand === brand && r.status === 'pending' && r.createdAt < cut.pendingBefore).length;
      repo.rows = repo.rows.filter(
        (r) =>
          !(r.brand === brand && r.status === 'pending' && r.createdAt < cut.pendingBefore) &&
          !(r.brand === brand && r.status === 'unsubscribed' && r.unsubscribedAt && r.unsubscribedAt < cut.unsubscribedBefore),
      );
      return { pending, unsubscribed: before - repo.rows.length - pending };
    },
    async newJobs(q) {
      repo.newJobsCalls.push(q);
      const matching = repo.jobs.filter((j) => j.firstSeenAt > q.since).sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
      return { rows: matching.slice(0, q.take).map(({ firstSeenAt: _f, ...row }) => row), total: matching.length };
    },
  };
  return repo;
}
