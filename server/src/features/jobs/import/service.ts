// server/src/features/jobs/import/service.ts — "Added by you" (WP-35;
// PRODUCT_PLAN.md F-TRK-04, F-EXT-09 server side; ARCH §3.4).
//
//   importJob(userId, { url })      read the page (Firecrawl only) → a draft
//   importJob(userId, { manual })   save the confirmed job (credit job_import)
//   saveJob(userId, fields, opts)   the save on its own, for the extension's
//                                   "Save" (WP-55a) and the Assistant's
//                                   add_external_job (WP-50) — same limits
//   status / listAdded / removeAdded
//
// Order of checks on every read or save, whoever calls: active lock → hourly
// limit → work → failure/success bookkeeping. A save confirming a signed
// draft is not counted again, once: the draft's nonce is claimed (single use)
// and only a draft to check or complete (needs_fields / needs_text) qualifies.
// The save never charges for a job that already exists (the user's own
// earlier import, or the same job in our public listings).

import crypto from 'node:crypto';
import { logger } from '../../../services/LoggerService.js';
import { HttpError } from '../../../platform/http.js';
import { getCurrentBrandOrDefault, type EnvSource, type ProductBrand } from '../../../platform/brand/index.js';
import { assertNoPiInPayload, EgressPolicyError, isCnMainland } from '../../../platform/residency/index.js';
import { isEnabled } from '../../../platform/flags.js';
import { CreditReplayError, creditService, type CreditService } from '../../../platform/credits/index.js';
import { normalizeProviderJob, type NormalizedJob } from '../normalize/index.js';
import { afterNormalize as marketAfterNormalize, type MarketHookContext, type MarketHookJob } from '../marketHooks.js';
import { detectScamSignals, enqueueJobEnrich, enrichJob, type EnrichOutcome } from '../enrich/index.js';
import { cnImportWarnings } from '../../cn/jobs/index.js';
import {
  IMPORT_ERROR_CODES,
  type AddedJobItem,
  type AddedJobsResponse,
  type ImportDraft,
  type ImportJobBody,
  type ImportJobResponse,
  type ImportReason,
  type ImportStatusResponse,
  type ImportWarning,
  type ManualJob,
} from './contract.js';
import { extractDraft } from './extract.js';
import { FIRECRAWL_SCRAPE_URL, ScrapeError, scrapeJobPage, type ScrapedPage } from './firecrawl.js';
import { draftImportId, isConfirmableDraft, jobIdFromImportId, jobImportId, verifyDraftImportId } from './importId.js';
import { createImportLimitStore, type ImportLimitStore } from './limits.js';
import { createPrismaImportRepository, type ImportRepository } from './repository.js';
import { checkImportUrl, isDeniedHost, normalizeHost } from './urlPolicy.js';

/**
 * Enrichment gets this long inside the request; after that it continues in
 * the queue. Kept well under every gateway's limit (FIX-3): at 45 s the job
 * was saved and the credit spent, but the browser got a 500 from the gateway
 * about 40 s in, so the person saw an error and the list did not show a job
 * that existed. Enrichment that needs longer loses nothing by finishing in the
 * queue.
 */
export const IMPORT_ENRICH_TIMEOUT_MS = 12_000;

/** Where a save comes from (credit ref and logs). */
export type SaveSource = 'import' | 'extension' | 'assistant';

export interface SaveJobOptions {
  /** Client Idempotency-Key; default: derived from the job's content, so a double click never charges twice. */
  idempotencyKey?: string | null;
  source?: SaveSource;
  /** The draft these fields confirm (from a link read); its first confirming save skips the hourly count. */
  importId?: string | null;
}

export interface JobImportDeps {
  repo: ImportRepository;
  limits: ImportLimitStore;
  credits: Pick<CreditService, 'withCredit'>;
  scrape: (url: string, env: EnvSource) => Promise<ScrapedPage>;
  enrich: (jobId: string) => Promise<EnrichOutcome>;
  enqueueEnrich: (jobId: string, market: string) => Promise<unknown>;
  afterNormalize: (job: MarketHookJob, ctx: MarketHookContext) => Promise<MarketHookJob>;
  /** Whether the brand's public listings may be shown to this user (R-14: off for GoApply until licensed). */
  publicListingsOn: (userId: string, brand: ProductBrand, env: EnvSource) => Promise<boolean>;
  assertNoPi: typeof assertNoPiInPayload;
  brand: () => ProductBrand;
  env: EnvSource;
  now: () => Date;
  enrichTimeoutMs: number;
}

export function defaultJobImportDeps(overrides: Partial<JobImportDeps> = {}): JobImportDeps {
  return {
    repo: createPrismaImportRepository(),
    limits: createImportLimitStore(),
    credits: creditService,
    scrape: (url, env) => scrapeJobPage(url, { apiKey: env.FIRECRAWL_API_KEY }),
    enrich: (jobId) => enrichJob({ jobId }, { attempt: 1, maxAttempts: 1 }),
    enqueueEnrich: (jobId, market) => enqueueJobEnrich(jobId, { market }),
    afterNormalize: (job, ctx) => marketAfterNormalize(job, ctx),
    publicListingsOn: (userId, brand, env) => isEnabled('jobs.feed', { userId, brand, env }),
    assertNoPi: assertNoPiInPayload,
    brand: () => getCurrentBrandOrDefault(),
    env: process.env,
    now: () => new Date(),
    enrichTimeoutMs: IMPORT_ENRICH_TIMEOUT_MS,
    ...overrides,
  };
}

export interface JobImportService {
  importJob(userId: string, body: ImportJobBody, idempotencyKey?: string | null): Promise<ImportJobResponse>;
  saveJob(userId: string, fields: ManualJob, options?: SaveJobOptions): Promise<ImportJobResponse>;
  status(userId: string, importId: string): Promise<ImportStatusResponse>;
  listAdded(userId: string, query: { cursor?: string; limit: number }): Promise<AddedJobsResponse>;
  removeAdded(userId: string, jobId: string): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** `[{ rule, evidence }]` from a stored or hook-written `fraudFlags` value. */
export function warningsFrom(value: unknown): ImportWarning[] {
  if (!Array.isArray(value)) return [];
  const out: ImportWarning[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const rule = (v as { rule?: unknown })?.rule;
    const evidence = (v as { evidence?: unknown })?.evidence;
    if (typeof rule !== 'string' || typeof evidence !== 'string' || !rule) continue;
    const key = `${rule}\u0000${evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule, evidence });
  }
  return out;
}

/**
 * Warnings stored on a job: every `fraudFlags` entry (rule-based scam
 * signals, and on GoApply the fraud rules), plus `cnImportWarnings(job)` for
 * a mainland job so a GoApply fraud flag is shown however it was recorded.
 */
export function storedWarnings(job: { fraudFlags: unknown; market?: string | null }): ImportWarning[] {
  const flags = Array.isArray(job.fraudFlags) ? job.fraudFlags : [];
  const cn = job.market === 'cn' ? cnImportWarnings({ fraudFlags: job.fraudFlags }) : [];
  return warningsFrom([...flags, ...cn]);
}

function notFound(): HttpError {
  return new HttpError('not_found', 'This import was not found.', { reason: IMPORT_ERROR_CODES.notFound });
}

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Stable per-user id of a saved job's content (RAJob.externalId; unique with sourceBoard). */
export function importExternalId(userId: string, fields: ManualJob): string {
  const digest = crypto
    .createHash('sha256')
    .update([norm(fields.title), norm(fields.company), norm(fields.location), (fields.applyUrl ?? '').trim(), norm(fields.description)].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
  return `u:${userId}:${digest}`;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}~${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('~');
    const createdAt = new Date(iso ?? '');
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return normalizeHost(new URL(url).hostname).replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Service ───────────────────────────────────────────────────────────────

export function createJobImportService(partial: Partial<JobImportDeps> = {}): JobImportService {
  let resolved: JobImportDeps | null = null;
  const deps = (): JobImportDeps => (resolved ??= defaultJobImportDeps(partial));

  function draftResponse(
    userId: string,
    status: 'needs_text' | 'needs_fields' | 'failed',
    reason: ImportReason | null,
    draft: ImportDraft | null,
    missingFields: ImportJobResponse['missingFields'],
    warnings: ImportWarning[] = [],
  ): ImportJobResponse {
    const d = deps();
    return {
      importId: draftImportId({ userId, status, missingFields, reason }, { env: d.env, now: d.now() }),
      status,
      jobId: null,
      missingFields,
      warnings,
      reason,
      draft,
      matched: null,
    };
  }

  /** A draft that keeps only the link (the user pastes or types the rest). */
  function linkOnlyDraft(url: string | null): ImportDraft | null {
    return url ? { title: null, company: null, description: null, location: null, applyUrl: url, sources: { applyUrl: 'link' } } : null;
  }

  /** Rule-based and market-hook warnings for a job that is not saved yet. */
  async function previewWarnings(userId: string, brand: ProductBrand, job: MarketHookJob, descriptionPlain: string): Promise<ImportWarning[]> {
    const d = deps();
    const now = d.now().toISOString();
    const flags: Array<{ rule: string; evidence: string; at: string }> = detectScamSignals(descriptionPlain, brand.market).map((s) => ({
      rule: s.rule,
      evidence: s.quote,
      at: now,
    }));
    try {
      const hooked = await d.afterNormalize(job, { brand: brand.id, market: brand.market, stage: 'import', userId });
      flags.push(...(Array.isArray(hooked.fraudFlags) ? (hooked.fraudFlags as typeof flags) : []));
      // GoApply: the warnings the cn hook prepared for a user's own import (WP-41 `cnFraudWarnings`).
      flags.push(...warningsFrom(hooked.cnFraudWarnings).map((w) => ({ ...w, at: now })));
    } catch (err) {
      logger.warn('JOB_IMPORT', 'market hook failed on an import preview', { error: err instanceof Error ? err.message : String(err) });
    }
    return warningsFrom(flags);
  }

  async function readLink(userId: string, url: string): Promise<ImportJobResponse> {
    const d = deps();
    const brand = d.brand();
    const check = checkImportUrl(url, d.env);
    if (!check.ok) {
      if (check.reason === 'blocked_site') return draftResponse(userId, 'needs_text', 'blocked_site', linkOnlyDraft(url), ['title', 'company', 'description']);
      return draftResponse(userId, 'failed', 'not_a_web_address', null, ['title', 'company', 'description']);
    }
    const link = check.url.toString();
    const allMissing: ImportJobResponse['missingFields'] = ['title', 'company', 'description'];
    // GoApply on the mainland stack never calls Firecrawl (CN-1); nor does a deployment without a key.
    if ((brand.market === 'cn' && isCnMainland(d.env)) || !d.env.FIRECRAWL_API_KEY?.trim()) {
      return draftResponse(userId, 'needs_text', 'fetch_unavailable', linkOnlyDraft(link), allMissing);
    }
    try {
      d.assertNoPi({ brand: brand.id, target: FIRECRAWL_SCRAPE_URL, payload: { url: link }, knownValues: await d.repo.knownValues(userId), env: d.env });
    } catch (err) {
      if (err instanceof EgressPolicyError && err.policyCode === 'pi_in_payload') {
        return draftResponse(userId, 'failed', 'personal_info_in_link', null, allMissing);
      }
      if (err instanceof EgressPolicyError) return draftResponse(userId, 'needs_text', 'fetch_unavailable', linkOnlyDraft(link), allMissing);
      throw err;
    }

    let page: ScrapedPage;
    try {
      page = await d.scrape(link, d.env);
    } catch (err) {
      const kind = err instanceof ScrapeError ? err.kind : 'http_error';
      logger.info('JOB_IMPORT', 'page read failed', { host: check.host, kind });
      if (kind === 'not_configured') return draftResponse(userId, 'needs_text', 'fetch_unavailable', linkOnlyDraft(link), allMissing);
      return draftResponse(userId, 'failed', kind === 'too_large' ? 'too_large' : 'fetch_failed', linkOnlyDraft(link), allMissing);
    }
    // A redirect onto a listed board: discard what came back.
    const finalHost = hostOfUrl(page.finalUrl);
    if (finalHost && isDeniedHost(finalHost, d.env)) return draftResponse(userId, 'needs_text', 'blocked_site', linkOnlyDraft(link), allMissing);

    const { draft, missingFields, foundAnything } = extractDraft(page, link);
    if (!foundAnything) return draftResponse(userId, 'failed', 'nothing_found', linkOnlyDraft(link), allMissing);
    const warnings = await previewWarnings(
      userId,
      brand,
      { market: brand.market, provider: 'user_import', title: draft.title ?? '', companyName: draft.company ?? '', description: draft.description ?? '', descriptionPlain: draft.description ?? '' },
      draft.description ?? '',
    );
    return draftResponse(userId, 'needs_fields', null, draft, missingFields, warnings);
  }

  async function enrichInRequest(jobId: string, market: string): Promise<void> {
    const d = deps();
    let deferred = false;
    try {
      const outcome = await withTimeout(d.enrich(jobId), d.enrichTimeoutMs);
      deferred = outcome.status === 'deferred';
    } catch (err) {
      logger.info('JOB_IMPORT', 'enrichment continues in the queue', { jobId, error: err instanceof Error ? err.message : String(err) });
      deferred = true;
    }
    if (!deferred) return;
    try {
      await d.enqueueEnrich(jobId, market);
    } catch (err) {
      logger.warn('JOB_IMPORT', 'could not queue enrichment', { jobId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function doneFor(jobId: string, matched: ImportJobResponse['matched']): Promise<ImportJobResponse> {
    const stored = await deps().repo.loadJob(jobId);
    return {
      importId: jobImportId(jobId),
      status: 'done',
      jobId,
      missingFields: [],
      warnings: stored ? storedWarnings(stored) : [],
      reason: null,
      draft: null,
      matched,
    };
  }

  /**
   * The abuse limits every read and save goes through (F-TRK-04, ARCH §3.10):
   * an active lock answers 429; otherwise one hourly unit is spent, except by
   * the first save that confirms a draft this user was given.
   */
  async function enforceLimits(userId: string, now: Date, importId: string | null | undefined): Promise<void> {
    const d = deps();
    const lockedUntil = await d.limits.activeLock(userId, now);
    if (lockedUntil) {
      const retryAfterSec = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
      throw new HttpError(
        'rate_limited',
        'Adding jobs is paused for a while after many failed attempts.',
        { reason: IMPORT_ERROR_CODES.locked, retryAfterSec, lockedUntil: lockedUntil.toISOString() },
        { 'Retry-After': String(retryAfterSec) },
      );
    }
    const claims = importId ? verifyDraftImportId(importId, userId, { env: d.env, now }) : null;
    const confirmsDraft = isConfirmableDraft(claims) && (await d.limits.claimDraft(userId, claims.nonce, new Date(claims.exp * 1000)));
    if (confirmsDraft) return;
    const hourly = await d.limits.consumeHourly(userId, now);
    if (!hourly.allowed) {
      throw new HttpError(
        'rate_limited',
        'You have added many jobs in the last hour. Try again later.',
        { reason: IMPORT_ERROR_CODES.hourly, retryAfterSec: hourly.retryAfterSec },
        { 'Retry-After': String(hourly.retryAfterSec) },
      );
    }
  }

  /** Limits, then the save, then the success bookkeeping: the one entry point for every caller. */
  async function saveJob(userId: string, fields: ManualJob, options: SaveJobOptions = {}): Promise<ImportJobResponse> {
    const d = deps();
    await enforceLimits(userId, d.now(), options.importId);
    const saved = await persistJob(userId, fields, options);
    await d.limits.recordSuccess(userId);
    return saved;
  }

  async function persistJob(userId: string, fields: ManualJob, options: SaveJobOptions): Promise<ImportJobResponse> {
    const d = deps();
    const brand = d.brand();
    const now = d.now();
    const externalId = importExternalId(userId, fields);
    const normalized: NormalizedJob = normalizeProviderJob(
      {
        externalId,
        title: fields.title,
        company: fields.company,
        description: fields.description,
        applyUrl: fields.applyUrl ?? null,
        sourceUrl: fields.applyUrl ?? null,
        location: fields.location ?? null,
        fetchedAt: now,
      },
      'user_import',
      { market: brand.market, ownerUserId: userId, now },
    );
    const placeKnown = !!(normalized.locationCity || normalized.locationCountry || normalized.remoteScope);
    const dedupeKey = placeKnown ? normalized.dedupeKey : null;
    // The user's own jobs match on identical content, or the same link and title only: two postings with
    // the same title, company and place (another team, a new link or post) are two jobs to them.
    const ownMatch = { externalId, applyUrl: normalized.applyUrl || null, titleNormalized: normalized.titleNormalized };

    // 1. The user's own earlier import of the same job: reuse it (restored when removed), no charge.
    const own = await d.repo.findOwnImport(userId, ownMatch);
    if (own) {
      if (own.archivedAt) await d.repo.restore(own.id);
      return doneFor(own.id, 'yours');
    }

    // 2. The same job in our public listings (only where the brand may show them): use it, no charge.
    if (await d.publicListingsOn(userId, brand, d.env)) {
      const urls = normalized.applyUrl ? [normalized.applyUrl] : [];
      const pub = await d.repo.findPublicMatch({ market: brand.market, urls, dedupeKey });
      if (pub) return doneFor(pub.id, 'public');
    }

    // 3. A new private job.
    const preview = await previewWarnings(userId, brand, { ...normalized, ownerUserId: userId } as MarketHookJob, normalized.descriptionPlain);
    const at = now.toISOString();
    const fraudFlags = preview.map((w) => ({ rule: w.rule, evidence: w.evidence, at }));
    const companyId = await d.repo.findCompanyId(brand.market, normalized.companyNameNormalized);

    let created: { id: string };
    try {
      created = await d.credits.withCredit(
        {
          userId,
          bucket: 'job_import',
          idempotencyKey: options.idempotencyKey?.trim() || `import:${externalId}`,
          refType: `job_import:${options.source ?? 'import'}`,
          refId: externalId,
          brand: brand.id,
        },
        () => d.repo.createPrivateJob({ job: normalized, ownerUserId: userId, companyId, fraudFlags }),
      );
    } catch (err) {
      const unique = (err as { code?: string } | null)?.code === 'P2002';
      if (unique || err instanceof CreditReplayError) {
        // A double submit that raced us: answer with the job the first request saved.
        const again = await d.repo.findOwnImport(userId, ownMatch);
        if (again) return doneFor(again.id, 'yours');
        if (err instanceof CreditReplayError) throw new HttpError('conflict', 'This request was already used for another job. Try again.');
      }
      throw err;
    }
    logger.info('JOB_IMPORT', 'job added', { jobId: created.id, source: options.source ?? 'import', market: brand.market });
    await enrichInRequest(created.id, brand.market);
    return doneFor(created.id, null);
  }

  return {
    async importJob(userId, body, idempotencyKey) {
      if ('manual' in body) return saveJob(userId, body.manual, { idempotencyKey, source: 'import', importId: body.importId ?? null });

      const d = deps();
      const now = d.now();
      await enforceLimits(userId, now, null);
      const result = await readLink(userId, body.url);
      if (result.status === 'failed') {
        const failure = await d.limits.recordFailure(userId, now);
        if (failure.lockedUntil) logger.warn('JOB_IMPORT', 'import locked after repeated failures', { userId, long: failure.longLock });
      } else if (result.status === 'needs_fields') {
        await d.limits.recordSuccess(userId);
      }
      return result;
    },

    saveJob,

    async status(userId, importId) {
      const d = deps();
      const jobId = jobIdFromImportId(importId);
      if (jobId) {
        const job = await d.repo.loadJob(jobId);
        if (!job) throw notFound();
        const own = job.ownerUserId === userId;
        if (job.visibility !== 'public' && !own) throw notFound();
        if (own && job.archivedAt) throw notFound();
        return { status: 'done', jobId, missingFields: [], warnings: storedWarnings(job), reason: null };
      }
      const claims = verifyDraftImportId(importId, userId, { env: d.env, now: d.now() });
      if (!claims) throw notFound();
      return { status: claims.status, jobId: null, missingFields: claims.missingFields, warnings: [], reason: claims.reason };
    },

    async listAdded(userId, query) {
      const d = deps();
      const rows = await d.repo.listAdded(userId, { before: decodeCursor(query.cursor), take: query.limit + 1 });
      const page = rows.slice(0, query.limit);
      const statuses = await d.repo.trackerStatuses(userId, page.map((r) => r.id));
      const items: AddedJobItem[] = page.map((r) => ({
        jobId: r.id,
        title: r.title,
        companyName: r.companyName,
        location: r.location,
        workModel: r.workModel === 'remote' || r.workModel === 'hybrid' || r.workModel === 'onsite' ? r.workModel : null,
        applyUrl: r.applyUrl || null,
        sourceHost: hostOfUrl(r.applyUrl || null),
        addedAt: r.createdAt.toISOString(),
        warnings: storedWarnings(r),
        trackerStatus: statuses.get(r.id) ?? null,
      }));
      const last = page[page.length - 1];
      return { items, cursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null };
    },

    async removeAdded(userId, jobId) {
      const d = deps();
      if (!(await d.repo.archiveAdded(userId, jobId, d.now()))) throw notFound();
    },
  };
}

export const jobImportService: JobImportService = createJobImportService();
