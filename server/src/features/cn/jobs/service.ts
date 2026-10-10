// server/src/features/cn/jobs/service.ts — GoApply jobs: the anti-fraud
// classifier around the pipeline hooks, the LLM check worker, and the admin
// fraud review and employer blacklist (CN-E-08, F-TRUST-04 cn, F-FEED-12 cn).
//
// Flow for one mainland job:
//   ingest / import  → afterNormalize: keyword rules + blacklist on the
//                      normalized job (`fraudFlags`, `class_year:` tags, and
//                      `cnFraudWarnings` for a user's own import);
//   enrich           → afterEnrich: the same rules on the stored row (with
//                      admin "cleared" memory), persisted; a posting with
//                      gray-zone wording and no keyword flag gets one
//                      `cn.jobs.fraudCheck` item per posting content
//                      (cheap CN LLM, worker; an edit is checked again);
//   admin            → clear (flags removed, never re-raised for the same
//                      evidence) or confirm (indexed job archived as
//                      'reported'; optionally the employer is blacklisted and
//                      every open job of that employer is flagged).
// A non-empty `fraudFlags` keeps a job out of ranking and recommendations
// (WP-32 / match repo). Flagged indexed jobs are never shown with a warning:
// they are not shown. A user's own import keeps showing, with the warning.

import { createHash } from 'node:crypto';
import { logger } from '../../../services/LoggerService.js';
import { calculateModelCost } from '../../../lib/modelPricing.js';
import { aiAllowed as platformAiAllowed } from '../../../platform/consent/index.js';
import { enqueue } from '../../../platform/queue/index.js';
import { HttpError } from '../../../platform/http.js';
import type { EnvSource } from '../../../platform/brand/index.js';
import { systemUserIdFor } from '../../jobs/enrich/index.js';
import type { MarketHookContext, MarketHookJob } from '../../jobs/marketHooks.js';
import type {
  BlacklistAddResponse,
  BlacklistEntryView,
  CnFraudFlag,
  FraudQueueItem,
  FraudQueueResponse,
  FraudQueueStatus,
  ResolveFraudResponse,
} from './contract.js';
import { GOHIRE_SOURCE_NAME, extractClassYearTags, mergeClassYearTags, readMarketTags } from './card.js';
import { cnFlagsOf, flagKey, mergeCnFraudFlags, sameFlags, signalsToFlags, withoutCnFlags, type StoredFraudFlag } from './fraud/flags.js';
import { detectCnFraudSignals, hasGrayCues } from './fraud/keywords.js';
import { defaultFraudLlm, resolveFraudModel, runFraudCall, type FraudLlm } from './fraud/llm.js';
import { defaultCnJobsRepository, type CnFraudJob, type CnJobsRepository } from './repository.js';
import { BlacklistConflictError, blacklistHit, defaultCnJobsStore, type BlacklistEntry, type CnJobsStore, type FraudReview } from './store.js';
import { postingText } from './text.js';

export const CN_JOBS_FRAUD_CHECK_KIND = 'cn.jobs.fraudCheck';
/** Admin list page size. */
export const FRAUD_PAGE_SIZE = 50;
/** Reported-but-unflagged jobs considered for the first page. */
export const MAX_REPORTED_JOBS = 200;
/** Open jobs of one employer flagged or unflagged per blacklist change. */
export const MAX_EMPLOYER_SWEEP = 500;

export interface CnJobsDeps {
  repo: CnJobsRepository;
  store: CnJobsStore;
  llm: FraudLlm;
  aiAllowed: (userId: string) => Promise<boolean>;
  /** `contentHash` = sha1 of the posting text: an edited posting is checked again. */
  enqueueFraudCheck: (jobId: string, contentHash: string) => Promise<void>;
  env: EnvSource;
  now: () => Date;
}

export function defaultCnJobsDeps(): CnJobsDeps {
  return {
    repo: defaultCnJobsRepository(),
    store: defaultCnJobsStore(),
    llm: defaultFraudLlm,
    aiAllowed: (userId) => platformAiAllowed(userId),
    enqueueFraudCheck: async (jobId, contentHash) => {
      await enqueue(CN_JOBS_FRAUD_CHECK_KIND, { jobId }, { brand: 'goapply', dedupeKey: fraudCheckDedupeKey(jobId, contentHash) });
    },
    env: process.env,
    now: () => new Date(),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** sha1 of the posting text the LLM check reads. */
export function postingHash(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** One LLM check per job and posting content (an edit queues a new check). */
export function fraudCheckDedupeKey(jobId: string, contentHash: string): string {
  return `${CN_JOBS_FRAUD_CHECK_KIND}:${jobId}:${contentHash}`;
}

// ── Classification ───────────────────────────────────────────────────────

export function blacklistFlag(entry: Pick<BlacklistEntry, 'employerName' | 'reason'>, at: Date): CnFraudFlag {
  return { rule: 'blacklisted_employer', evidence: `${entry.employerName}: ${entry.reason}`.slice(0, 240), at: at.toISOString(), method: 'blacklist' };
}

/** Keyword and blacklist flags for a posting (no LLM). */
export function ruleFlags(job: Record<string, unknown>, blacklist: readonly BlacklistEntry[], at: Date): CnFraudFlag[] {
  const flags = signalsToFlags(detectCnFraudSignals(postingText(job)), 'keywords', at);
  const hit = blacklistHit(str(job.companyName), blacklist);
  if (hit) flags.push(blacklistFlag(hit, at));
  return flags;
}

/** Warnings for a user's own import (WP-35 shows them before saving). */
export function cnImportWarnings(job: Record<string, unknown>): Array<{ rule: string; evidence: string }> {
  return cnFlagsOf(job.fraudFlags).map((f) => ({ rule: f.rule, evidence: f.evidence }));
}

/**
 * Stable key of a posting across re-ingests: `${sourceBoard}:${externalId}`
 * (RAJob's unique pair). Null when either part is missing.
 */
export function fraudSourceKey(sourceBoard: unknown, externalId: unknown): string | null {
  const board = str(sourceBoard).trim();
  const ext = str(externalId).trim();
  return board && ext ? `${board}:${ext}` : null;
}

/** Flag keys an admin cleared for this job, matched by row id or by source key. */
export function clearedKeysIn(reviews: readonly FraudReview[], ref: { id?: unknown; sourceBoard?: unknown; externalId?: unknown }): Set<string> {
  const id = str(ref.id);
  const sourceKey = fraudSourceKey(ref.sourceBoard, ref.externalId);
  return new Set(reviews.filter((r) => (id && r.jobId === id) || (sourceKey && r.sourceKey === sourceKey)).flatMap((r) => r.clearedKeys));
}

async function clearedKeysFor(deps: CnJobsDeps, ref: { id?: unknown; sourceBoard?: unknown; externalId?: unknown }): Promise<Set<string>> {
  return clearedKeysIn(await deps.store.listReviews(), ref);
}

// ── Hooks ────────────────────────────────────────────────────────────────

/**
 * afterNormalize for mainland jobs (ingest and import): GoHire source name,
 * rule flags, 届别 tags. A blacklist read failure does not drop the job (the
 * afterEnrich pass retries with the queue).
 */
export async function cnAfterNormalize(job: MarketHookJob, ctx: MarketHookContext, deps: CnJobsDeps): Promise<MarketHookJob> {
  if (job.market !== 'cn') return job;
  const out: MarketHookJob = { ...job };
  if (job.provider === 'bank_gohire' && !str(job.sourceName).trim()) out.sourceName = GOHIRE_SOURCE_NAME;
  let blacklist: BlacklistEntry[] = [];
  let cleared = new Set<string>();
  try {
    blacklist = await deps.store.blacklistCached();
    // An admin "clear" holds on re-ingest too: matched by row id, or by sourceBoard:externalId.
    cleared = clearedKeysIn(await deps.store.reviewsCached(), job);
  } catch (err) {
    logger.warn('CN_JOBS', 'blacklist or review log unavailable at normalize; checked again after enrichment', { error: err instanceof Error ? err.message : String(err) });
  }
  out.fraudFlags = mergeCnFraudFlags(job.fraudFlags, ruleFlags(job, blacklist, deps.now()), ['keywords', 'blacklist'], cleared);
  out.marketTags = mergeClassYearTags(job.marketTags, extractClassYearTags(postingText(job)));
  if (ctx.stage === 'import') out.cnFraudWarnings = cnImportWarnings(out);
  return out;
}

/**
 * afterEnrich for mainland jobs: the rules again on the stored row (the
 * enrichment update is merged into `job`), persisted when they changed;
 * gray-zone postings without a keyword flag are queued for the LLM check.
 * Errors propagate (the enrichment queue retries the hooks).
 */
export async function cnAfterEnrich(job: MarketHookJob, _ctx: MarketHookContext, deps: CnJobsDeps): Promise<void> {
  if (job.market !== 'cn' || typeof job.id !== 'string' || !job.id) return;
  if (job.archivedAt) return;
  const cleared = await clearedKeysFor(deps, job);
  const blacklist = await deps.store.blacklistCached();
  const fraudFlags = mergeCnFraudFlags(job.fraudFlags, ruleFlags(job, blacklist, deps.now()), ['keywords', 'blacklist'], cleared);
  const text = postingText(job);
  const marketTags = mergeClassYearTags(job.marketTags, extractClassYearTags(text));
  const update: { fraudFlags?: unknown; marketTags?: unknown } = {};
  if (!sameFlags(fraudFlags, job.fraudFlags)) update.fraudFlags = fraudFlags;
  if (JSON.stringify(marketTags ?? null) !== JSON.stringify(readMarketTags(job.marketTags).length ? readMarketTags(job.marketTags) : null)) update.marketTags = marketTags;
  if (Object.keys(update).length) await deps.repo.saveFraudFields(job.id, update);
  if (cnFlagsOf(fraudFlags).length === 0 && hasGrayCues(text) && resolveFraudModel(deps.env).available) await deps.enqueueFraudCheck(job.id, postingHash(text));
}

// ── LLM check worker ─────────────────────────────────────────────────────

export type FraudCheckOutcome =
  | { status: 'skipped'; reason: 'not_found' | 'archived' | 'not_cn' | 'unavailable' | 'no_ai_consent' }
  | { status: 'checked'; flagged: number; model: string };

/** One `cn.jobs.fraudCheck` item. Throws on LLM failure (the queue retries). */
export async function runFraudCheck(jobId: string, deps: CnJobsDeps, requestId?: string): Promise<FraudCheckOutcome> {
  const job = await deps.repo.loadJob(jobId);
  if (!job) return { status: 'skipped', reason: 'not_found' };
  if (job.archivedAt) return { status: 'skipped', reason: 'archived' };
  if (job.market !== 'cn') return { status: 'skipped', reason: 'not_cn' };
  const route = resolveFraudModel(deps.env);
  if (!route.available) return { status: 'skipped', reason: 'unavailable' };
  const ownImport = job.visibility === 'private';
  if (ownImport && (!job.ownerUserId || !(await deps.aiAllowed(job.ownerUserId)))) return { status: 'skipped', reason: 'no_ai_consent' };

  const text = postingText(job as unknown as Record<string, unknown>);
  const call = await runFraudCall({ title: job.title, companyName: job.companyName, postingText: text, route, carriesUserData: ownImport, requestId }, deps.llm);
  const cleared = await clearedKeysFor(deps, job);
  const fraudFlags = mergeCnFraudFlags(job.fraudFlags, signalsToFlags(call.signals, 'llm', deps.now()), ['llm'], cleared);
  if (!sameFlags(fraudFlags, job.fraudFlags)) await deps.repo.saveFraudFields(job.id, { fraudFlags });
  await deps.repo.logCost({
    userId: systemUserIdFor('cn', deps.env as Record<string, string | undefined>),
    jobId: job.id,
    model: call.model,
    promptTokens: call.usage.promptTokens,
    completionTokens: call.usage.completionTokens,
    costUsd: calculateModelCost(call.model, call.usage.promptTokens, call.usage.completionTokens),
    requestId: requestId ?? null,
  });
  return { status: 'checked', flagged: call.signals.length, model: call.model };
}

// ── Admin: review list ───────────────────────────────────────────────────

function toItem(
  job: CnFraudJob,
  flags: StoredFraudFlag[],
  reports: { count: number; firstAt: Date | null } | undefined,
  review: FraudReview | null,
  names: ReadonlyMap<string, string> = new Map(),
): FraudQueueItem {
  const times = [...flags.map((f) => f.at), ...(reports?.firstAt ? [reports.firstAt.toISOString()] : [])].filter(Boolean).sort();
  return {
    jobId: job.id,
    title: job.title,
    companyName: job.companyName,
    sourceName: job.sourceName ?? (job.sourceBoard === 'gohire' ? GOHIRE_SOURCE_NAME : null),
    visibility: job.visibility === 'private' ? 'private' : 'public',
    flags: flags.map((f) => ({ rule: f.rule, evidence: f.evidence, at: f.at, ...(f.method ? { method: f.method } : {}) })),
    reportCount: reports?.count ?? 0,
    flaggedAt: times[0] ?? null,
    review: review ? { decision: review.decision, note: review.note, at: review.at, by: review.by, byName: names.get(review.by) ?? null } : null,
  };
}

function latestReviews(reviews: readonly FraudReview[]): Map<string, FraudReview> {
  const out = new Map<string, FraudReview>();
  for (const r of reviews) {
    const prev = out.get(r.jobId);
    if (!prev || prev.at <= r.at) out.set(r.jobId, r);
  }
  return out;
}

/** 可疑职位待审核 — the admin review list. */
export async function listFraudQueue(deps: CnJobsDeps, status: FraudQueueStatus = 'flagged', cursor?: string): Promise<FraudQueueResponse> {
  const latest = latestReviews(await deps.store.listReviews());

  if (status !== 'flagged') {
    const decision = status === 'cleared' ? 'clear' : 'confirm';
    const reviewed = [...latest.values()].filter((r) => r.decision === decision).sort((a, b) => (a.at < b.at ? 1 : -1));
    const offset = cursor?.startsWith('o:') ? Math.max(0, Number(cursor.slice(2)) || 0) : 0;
    const page = reviewed.slice(offset, offset + FRAUD_PAGE_SIZE);
    const jobs = new Map((await deps.repo.jobsByIds(page.map((r) => r.jobId))).map((j) => [j.id, j]));
    const reports = await deps.repo.reportCounts(page.map((r) => r.jobId));
    const names = await deps.repo.userLabels([...new Set(page.map((r) => r.by))]);
    const items = page.flatMap((r) => {
      const job = jobs.get(r.jobId);
      if (!job) return [];
      const flags = decision === 'clear' ? (r.flags ?? []) : cnFlagsOf(job.fraudFlags);
      return [toItem(job, flags, reports.get(r.jobId), r, names)];
    });
    const next = offset + FRAUD_PAGE_SIZE < reviewed.length ? `o:${offset + FRAUD_PAGE_SIZE}` : null;
    return { items, cursor: next };
  }

  const afterId = cursor?.startsWith('f:') ? cursor.slice(2) : null;
  const rows = await deps.repo.listFlagged({ afterId, take: FRAUD_PAGE_SIZE });
  const flagged = rows.filter((j) => cnFlagsOf(j.fraudFlags).length > 0);
  let reportedOnly: CnFraudJob[] = [];
  if (!afterId) {
    const ids = (await deps.repo.reportedJobIds(MAX_REPORTED_JOBS)).filter((id) => !flagged.some((j) => j.id === id));
    reportedOnly = (await deps.repo.jobsByIds(ids)).filter((j) => !j.archivedAt && cnFlagsOf(j.fraudFlags).length === 0);
  }
  const all = [...flagged, ...reportedOnly];
  const reports = await deps.repo.reportCounts(all.map((j) => j.id));
  const items = all
    .filter((j) => {
      const flags = cnFlagsOf(j.fraudFlags);
      const review = latest.get(j.id);
      // A confirmed job (a user's own import keeps its flags and is not archived) leaves
      // "To review" until a flag newer than the decision is raised.
      if (review?.decision === 'confirm' && !flags.some((f) => f.at > review.at)) return false;
      // A reported-only job an admin already cleared stays cleared until it is flagged again.
      if (flags.length) return true;
      return review?.decision !== 'clear';
    })
    .map((j) => toItem(j, cnFlagsOf(j.fraudFlags), reports.get(j.id), null));
  const last = rows[rows.length - 1];
  return { items, cursor: rows.length === FRAUD_PAGE_SIZE && last ? `f:${last.id}` : null };
}

// ── Admin: resolve ───────────────────────────────────────────────────────

function employerCore(name: string): string {
  const core = name
    .trim()
    .replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司|集团|分公司|公司)$/u, '')
    .trim();
  return core.length >= 2 ? core : name.trim();
}

/**
 * Flag (or, on removal, unflag) every open job of a blacklisted employer.
 * `matched`: open jobs whose company the entry names; `changed`: jobs whose
 * flags were written.
 */
export async function sweepEmployer(deps: CnJobsDeps, entry: BlacklistEntry, mode: 'flag' | 'unflag'): Promise<{ matched: number; changed: number }> {
  const jobs = await deps.repo.openJobsOfEmployer(employerCore(entry.employerName), MAX_EMPLOYER_SWEEP);
  let matched = 0;
  let changed = 0;
  for (const job of jobs) {
    if (!blacklistHit(job.companyName, [entry])) continue;
    matched += 1;
    const next = mergeCnFraudFlags(job.fraudFlags, mode === 'flag' ? [blacklistFlag(entry, deps.now())] : [], ['blacklist']);
    if (sameFlags(next, job.fraudFlags)) continue;
    await deps.repo.saveFraudFields(job.id, { fraudFlags: next });
    changed += 1;
  }
  return { matched, changed };
}

export async function resolveFraud(
  deps: CnJobsDeps,
  jobId: string,
  body: { decision: 'clear' | 'confirm'; note?: string; blacklistEmployer?: boolean },
  adminId: string,
): Promise<ResolveFraudResponse> {
  if (body.blacklistEmployer && body.decision !== 'confirm') throw new HttpError('invalid_request', 'Only a confirmed job can add its employer to the block list.');
  const job = await deps.repo.loadJob(jobId);
  if (!job || job.market !== 'cn') throw new HttpError('not_found');
  const now = deps.now();
  const flags = cnFlagsOf(job.fraudFlags);
  const note = body.note?.trim() || null;
  const sourceKey = fraudSourceKey(job.sourceBoard, job.externalId);

  if (body.decision === 'clear') {
    await deps.repo.saveFraudFields(job.id, { fraudFlags: withoutCnFlags(job.fraudFlags) });
    await deps.store.addReview({ jobId: job.id, sourceKey, decision: 'clear', note, at: now.toISOString(), by: adminId, clearedKeys: flags.map(flagKey), flags });
    return { jobId: job.id, status: 'cleared', blacklistEntryId: null };
  }

  // Confirm: an indexed posting is taken down; a user's own import stays theirs, with the warning.
  if (job.visibility !== 'private' && !job.archivedAt) await deps.repo.closeAsFraud(job.id, now);
  await deps.store.addReview({ jobId: job.id, sourceKey, decision: 'confirm', note, at: now.toISOString(), by: adminId, clearedKeys: [], flags });
  let blacklistEntryId: string | null = null;
  if (body.blacklistEmployer) {
    const entry = await addToBlacklist(deps, { employerName: job.companyName, reason: note ?? 'Confirmed fraudulent posting' }, adminId, { allowExisting: true });
    blacklistEntryId = entry.id;
  }
  return { jobId: job.id, status: 'confirmed', blacklistEntryId };
}

// ── Admin: blacklist ─────────────────────────────────────────────────────

export function toBlacklistView(e: BlacklistEntry): BlacklistEntryView {
  return { id: e.id, employerName: e.employerName, reason: e.reason, createdAt: e.createdAt, createdBy: e.createdBy };
}

export async function listBlacklist(deps: CnJobsDeps): Promise<BlacklistEntryView[]> {
  return (await deps.store.listBlacklist()).map(toBlacklistView).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function addToBlacklist(
  deps: CnJobsDeps,
  input: { employerName: string; reason: string },
  adminId: string,
  options: { allowExisting?: boolean } = {},
): Promise<BlacklistAddResponse> {
  let entry: BlacklistEntry;
  try {
    entry = await deps.store.addBlacklist({ ...input, createdBy: adminId });
  } catch (err) {
    if (!(err instanceof BlacklistConflictError)) throw err;
    const existing = blacklistHit(input.employerName, await deps.store.listBlacklist());
    if (!options.allowExisting || !existing) throw new HttpError('conflict', 'This employer is already on the block list.');
    entry = existing;
  }
  const { matched } = await sweepEmployer(deps, entry, 'flag');
  // The admin sees how many open posts the name matched ("0" says the name is too short or misspelled).
  return { ...toBlacklistView(entry), matchedOpenJobs: matched };
}

export async function removeFromBlacklist(deps: CnJobsDeps, id: string): Promise<void> {
  const removed = await deps.store.removeBlacklist(id);
  if (!removed) throw new HttpError('not_found');
  await sweepEmployer(deps, removed, 'unflag');
}
