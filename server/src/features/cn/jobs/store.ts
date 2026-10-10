// server/src/features/cn/jobs/store.ts — employer blacklist and fraud-review
// log for GoApply (CN-E-08: evidence retention and a blacklist).
//
// Narrow typed adapter. There is no table for either yet (Schema requests
// SR-41-1 `RACnEmployerBlacklist`, SR-41-2 `RACnFraudReview` in the WP-41
// handoff), so both live as JSON documents in `AppConfig`:
//   cn.jobs.employerBlacklist.v1   BlacklistEntry[]
//   cn.jobs.fraudReviews.v1        FraudReview[] (newest last, capped)
// When the tables land only this file changes. Writes are admin-only and
// rare; a lost concurrent write is re-done by the admin, never silently
// invented.

import crypto from 'node:crypto';
import type prismaClient from '../../../lib/prisma.js';
import { employerKey } from './text.js';
import type { StoredFraudFlag } from './fraud/flags.js';

export const BLACKLIST_CONFIG_KEY = 'cn.jobs.employerBlacklist.v1';
export const REVIEWS_CONFIG_KEY = 'cn.jobs.fraudReviews.v1';
/** Review log cap (oldest dropped). */
export const MAX_REVIEWS = 2000;
/** How long the hooks reuse a blacklist or review-log read. */
export const BLACKLIST_CACHE_MS = 60_000;

export interface BlacklistEntry {
  id: string;
  employerName: string;
  /** `employerKey(employerName)`. */
  employerKey: string;
  reason: string;
  createdAt: string;
  createdBy: string;
}

export interface FraudReview {
  jobId: string;
  /**
   * `fraudSourceKey(sourceBoard, externalId)` of the job: the key a re-ingested
   * posting carries at afterNormalize, before it has (or knows) its row id.
   */
  sourceKey?: string | null;
  decision: 'clear' | 'confirm';
  note: string | null;
  at: string;
  by: string;
  /** `flagKey`s of the CN flags this review cleared (a re-run never brings them back). */
  clearedKeys: string[];
  /** The CN flags the job carried when it was reviewed (evidence retention). */
  flags?: StoredFraudFlag[];
}

/** The AppConfig slice this store uses (a fake in tests). */
export type ConfigDb = Pick<typeof prismaClient, 'appConfig'>;

export class BlacklistConflictError extends Error {
  constructor() {
    super('employer already on the blacklist');
    this.name = 'BlacklistConflictError';
  }
}

export interface CnJobsStore {
  listBlacklist(): Promise<BlacklistEntry[]>;
  /** Cached read for the pipeline hooks. */
  blacklistCached(): Promise<BlacklistEntry[]>;
  addBlacklist(input: { employerName: string; reason: string; createdBy: string }): Promise<BlacklistEntry>;
  removeBlacklist(id: string): Promise<BlacklistEntry | null>;
  listReviews(): Promise<FraudReview[]>;
  /** Cached read for the ingest hook (afterNormalize); dropped on every addReview in this process. */
  reviewsCached(): Promise<FraudReview[]>;
  reviewsFor(jobId: string): Promise<FraudReview[]>;
  addReview(review: FraudReview): Promise<void>;
}

function parseArray<T>(raw: string | undefined | null, valid: (v: unknown) => v is T): T[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(valid) : [];
  } catch {
    return [];
  }
}

const isEntry = (v: unknown): v is BlacklistEntry =>
  !!v && typeof v === 'object' && typeof (v as BlacklistEntry).id === 'string' && typeof (v as BlacklistEntry).employerName === 'string';

const isReview = (v: unknown): v is FraudReview =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as FraudReview).jobId === 'string' &&
  ((v as FraudReview).decision === 'clear' || (v as FraudReview).decision === 'confirm');

export function createCnJobsStore(getDb: () => Promise<ConfigDb>, options: { now?: () => Date } = {}): CnJobsStore {
  const now = options.now ?? (() => new Date());
  let cache: { at: number; entries: BlacklistEntry[] } | null = null;
  let reviewCache: { at: number; rows: FraudReview[] } | null = null;

  async function read<T>(key: string, valid: (v: unknown) => v is T): Promise<T[]> {
    const db = await getDb();
    const row = await db.appConfig.findUnique({ where: { key }, select: { value: true } });
    return parseArray(row?.value, valid);
  }

  async function write<T>(key: string, items: T[], by: string): Promise<void> {
    const db = await getDb();
    const value = JSON.stringify(items);
    await db.appConfig.upsert({ where: { key }, create: { key, value, updatedBy: by }, update: { value, updatedBy: by } });
  }

  const listBlacklist = () =>
    read(BLACKLIST_CONFIG_KEY, isEntry).then((rows) => rows.map((r) => ({ ...r, employerKey: r.employerKey || employerKey(r.employerName) })));

  return {
    listBlacklist,
    async blacklistCached() {
      const t = now().getTime();
      if (cache && t - cache.at < BLACKLIST_CACHE_MS) return cache.entries;
      const entries = await listBlacklist();
      cache = { at: t, entries };
      return entries;
    },
    async addBlacklist({ employerName, reason, createdBy }) {
      const rows = await listBlacklist();
      const key = employerKey(employerName);
      if (!key || rows.some((r) => r.employerKey === key)) throw new BlacklistConflictError();
      const entry: BlacklistEntry = {
        id: crypto.randomUUID(),
        employerName: employerName.trim(),
        employerKey: key,
        reason: reason.trim(),
        createdAt: now().toISOString(),
        createdBy,
      };
      await write(BLACKLIST_CONFIG_KEY, [...rows, entry], createdBy);
      cache = null;
      return entry;
    },
    async removeBlacklist(id) {
      const rows = await listBlacklist();
      const hit = rows.find((r) => r.id === id) ?? null;
      if (!hit) return null;
      await write(
        BLACKLIST_CONFIG_KEY,
        rows.filter((r) => r.id !== id),
        hit.createdBy,
      );
      cache = null;
      return hit;
    },
    listReviews: () => read(REVIEWS_CONFIG_KEY, isReview),
    async reviewsCached() {
      const t = now().getTime();
      if (reviewCache && t - reviewCache.at < BLACKLIST_CACHE_MS) return reviewCache.rows;
      const rows = await read(REVIEWS_CONFIG_KEY, isReview);
      reviewCache = { at: t, rows };
      return rows;
    },
    async reviewsFor(jobId) {
      return (await read(REVIEWS_CONFIG_KEY, isReview)).filter((r) => r.jobId === jobId);
    },
    async addReview(review) {
      const rows = await read(REVIEWS_CONFIG_KEY, isReview);
      rows.push(review);
      await write(REVIEWS_CONFIG_KEY, rows.slice(-MAX_REVIEWS), review.by);
      reviewCache = null;
    },
  };
}

/** Business-line words that follow a short trade name in a company name ("华为" + "技术"). */
const LINE_OF_BUSINESS =
  /^(科技|技术|网络|信息|电子|通信|通讯|软件|数码|数字|智能|教育|培训|咨询|管理|人力资源|人力|劳务|贸易|商贸|实业|投资|金融|文化|传媒|广告|电商|电子商务|物流|供应链|餐饮|医疗|医药|生物|建筑|工程|地产|置业|服务|传播|娱乐|健康|汽车|能源|集团|控股|股份)/u;
/** A short key may follow a city prefix of at most this many characters ("上海" + "鼎盛科技"). */
const MAX_PREFIX = 3;

/**
 * The blacklist entry that names this employer, if any: the exact key; a
 * blacklisted key of 4+ characters inside the name; or a 2-3 character key
 * (a short trade name such as "华为") at the start of the name, after a city
 * prefix of at most 3 characters, and followed by a line-of-business word.
 */
export function blacklistHit(companyName: string, entries: readonly BlacklistEntry[]): BlacklistEntry | null {
  const key = employerKey(companyName);
  if (!key) return null;
  const shortHit = (ek: string): boolean => {
    for (let i = key.indexOf(ek); i >= 0 && i <= MAX_PREFIX; i = key.indexOf(ek, i + 1)) {
      if (LINE_OF_BUSINESS.test(key.slice(i + ek.length))) return true;
    }
    return false;
  };
  return (
    entries.find((e) => e.employerKey === key) ??
    entries.find((e) => e.employerKey.length >= 4 && key.includes(e.employerKey)) ??
    entries.find((e) => e.employerKey.length >= 2 && e.employerKey.length < 4 && shortHit(e.employerKey)) ??
    null
  );
}

/** Default store over the shared Prisma client (imported lazily so tests never open a connection). */
let defaultStore: CnJobsStore | null = null;
export function defaultCnJobsStore(): CnJobsStore {
  return (defaultStore ??= createCnJobsStore(async () => (await import('../../../lib/prisma.js')).default));
}
