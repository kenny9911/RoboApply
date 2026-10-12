// Fakes for the GoApply jobs tests: an in-memory repository and store, a
// recording LLM and enqueue. No database, no network.

import { vi } from 'vitest';
import type { LLMChatResult } from '../../../../platform/llm/index.js';
import type { CnFraudJob, CnJobsRepository, FraudCostEntry } from '../repository.js';
import { BlacklistConflictError, blacklistHit, type BlacklistEntry, type CnJobsStore, type FraudReview } from '../store.js';
import type { CnJobsDeps } from '../service.js';
import { employerKey } from '../text.js';
import type { FraudLlm } from '../fraud/llm.js';

export const NOW = new Date('2026-10-10T08:00:00.000Z');

export function cnJob(over: Partial<CnFraudJob> = {}): CnFraudJob {
  const id = over.id ?? 'job_1';
  return {
    id,
    market: 'cn',
    visibility: 'public',
    ownerUserId: null,
    sourceBoard: 'gohire',
    externalId: `gh_${id}`,
    title: '产品经理',
    companyName: '示例科技有限公司',
    companyNameNormalized: '示例科技',
    sourceName: 'GoHire',
    description: '负责产品规划与需求分析。',
    descriptionPlain: '负责产品规划与需求分析。',
    qualifications: null,
    responsibilities: null,
    benefits: null,
    fraudFlags: null,
    marketTags: null,
    archivedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
    // The two text columns hold the same posting (as written, and its folded copy): a fixture that
    // sets only the plain one means that text for both, as every writer stores it.
    ...(over.descriptionPlain !== undefined && over.description === undefined ? { description: over.descriptionPlain } : {}),
  };
}

export interface FakeRepo extends CnJobsRepository {
  jobs: Map<string, CnFraudJob>;
  reports: Array<{ jobId: string; reasonCode: string; at: Date }>;
  costs: FraudCostEntry[];
  saves: Array<{ jobId: string; data: { fraudFlags?: unknown; marketTags?: unknown } }>;
  /** id → display label for userLabels. */
  users: Map<string, string>;
}

export function fakeRepo(jobs: CnFraudJob[] = []): FakeRepo {
  const map = new Map(jobs.map((j) => [j.id, { ...j }]));
  const repo: FakeRepo = {
    jobs: map,
    reports: [],
    costs: [],
    saves: [],
    users: new Map(),
    async loadJob(id) {
      const j = map.get(id);
      return j ? { ...j } : null;
    },
    async saveFraudFields(jobId, data) {
      repo.saves.push({ jobId, data });
      const j = map.get(jobId);
      if (!j) return;
      if (data.fraudFlags !== undefined) j.fraudFlags = data.fraudFlags;
      if (data.marketTags !== undefined) j.marketTags = data.marketTags;
    },
    async closeAsFraud(jobId, at) {
      const j = map.get(jobId);
      if (j) j.archivedAt = at;
    },
    async listFlagged({ afterId, take }) {
      return [...map.values()]
        .filter((j) => j.market === 'cn' && !j.archivedAt && j.fraudFlags != null && (!afterId || j.id > afterId))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, take);
    },
    async jobsByIds(ids) {
      return ids.map((id) => map.get(id)).filter((j): j is CnFraudJob => !!j && j.market === 'cn');
    },
    async reportCounts(ids) {
      const out = new Map<string, { count: number; firstAt: Date | null }>();
      for (const r of repo.reports) {
        if (!ids.includes(r.jobId)) continue;
        const prev = out.get(r.jobId);
        out.set(r.jobId, { count: (prev?.count ?? 0) + 1, firstAt: prev?.firstAt && prev.firstAt < r.at ? prev.firstAt : r.at });
      }
      return out;
    },
    async reportedJobIds() {
      return [...new Set(repo.reports.map((r) => r.jobId))].filter((id) => {
        const j = map.get(id);
        return j && j.market === 'cn' && !j.archivedAt;
      });
    },
    async openJobsOfEmployer(nameContains) {
      return [...map.values()].filter((j) => j.market === 'cn' && !j.archivedAt && j.companyName.toLowerCase().includes(nameContains.toLowerCase()));
    },
    async logCost(entry) {
      repo.costs.push(entry);
    },
    async userLabels(ids) {
      return new Map(ids.filter((id) => repo.users.has(id)).map((id) => [id, repo.users.get(id)!]));
    },
  };
  return repo;
}

export interface FakeStore extends CnJobsStore {
  blacklist: BlacklistEntry[];
  reviews: FraudReview[];
}

export function fakeStore(): FakeStore {
  let n = 0;
  const store: FakeStore = {
    blacklist: [],
    reviews: [],
    listBlacklist: async () => [...store.blacklist],
    blacklistCached: async () => [...store.blacklist],
    async addBlacklist({ employerName, reason, createdBy }) {
      const key = employerKey(employerName);
      if (store.blacklist.some((e) => e.employerKey === key)) throw new BlacklistConflictError();
      const entry = { id: `bl_${++n}`, employerName, employerKey: key, reason, createdAt: NOW.toISOString(), createdBy };
      store.blacklist.push(entry);
      return entry;
    },
    async removeBlacklist(id) {
      const hit = store.blacklist.find((e) => e.id === id) ?? null;
      store.blacklist = store.blacklist.filter((e) => e.id !== id);
      return hit;
    },
    listReviews: async () => [...store.reviews],
    reviewsCached: async () => [...store.reviews],
    reviewsFor: async (jobId) => store.reviews.filter((r) => r.jobId === jobId),
    async addReview(r) {
      store.reviews.push(r);
    },
  };
  return store;
}

export { blacklistHit };

export function fakeLlm(content: string | (() => string) = '{"flags": []}'): FraudLlm & { chatWithUsage: ReturnType<typeof vi.fn> } {
  return {
    chatWithUsage: vi.fn(
      async (): Promise<LLMChatResult> =>
        ({ content: typeof content === 'function' ? content() : content, model: 'deepseek/deepseek-chat', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }) as LLMChatResult,
    ),
  };
}

/** Env with a domestic GoApply model configured. */
export const CN_MODEL_ENV = { CN_LLM_MODEL: 'deepseek/deepseek-chat', DEEPSEEK_API_KEY: 'k' };

export function fakeDeps(over: Partial<CnJobsDeps> = {}): CnJobsDeps & { repo: FakeRepo; store: FakeStore; enqueued: string[]; enqueuedHashes: string[] } {
  const enqueued: string[] = [];
  const enqueuedHashes: string[] = [];
  const deps = {
    repo: fakeRepo(),
    store: fakeStore(),
    llm: fakeLlm(),
    aiAllowed: vi.fn(async () => true),
    enqueueFraudCheck: async (jobId: string, contentHash: string) => {
      enqueued.push(jobId);
      enqueuedHashes.push(contentHash);
    },
    env: {} as Record<string, string>,
    now: () => NOW,
    enqueued,
    enqueuedHashes,
    ...over,
  };
  return deps as CnJobsDeps & { repo: FakeRepo; store: FakeStore; enqueued: string[]; enqueuedHashes: string[] };
}
