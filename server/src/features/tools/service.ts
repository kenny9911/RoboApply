// server/src/features/tools/service.ts
//
// Free tools without an account (WP-57; PRODUCT_PLAN.md F-TOOL-02, F-TOOL-03).
// See ./contract.ts for the rules. Order of a run:
//   0. GoApply in CN-0: the tools are off (404 feature_disabled);
//   1. validate the file (size, type, first bytes) and the fields — free;
//   2. GoApply: the processing notice must be ticked (TOOLS_CONSENT_VERSION);
//   3. the per-IP attempts guard (20 a day across both tools, fail closed) —
//      bounds the parses and rows one IP can cause;
//   4. the 24 h hash cache: the same file (and posting) from the same browser
//      answers from the cache with a fresh result id and does not use a
//      check (earlier ids of that row stay valid: the new one is an alias row);
//   5. today's allowance for this tool is read (3 a day per IP per tool) —
//      none left → 429 before any parse; one run per visitor and tool at a
//      time on this instance;
//   6. parse through the brand's parser path — an unreadable file stops here
//      and does NOT use a check;
//   7. the check is counted (persisted, fail closed; a lost race → 429);
//   8. run the deterministic check; store the cache row — report and resume
//      text redacted per the brand's storage rule, the visitor-cookie hash,
//      GoApply's consent version — and purge expired rows of the brand;
//   9. answer the short view (resume check: top issues only).
// Reads and the claim need the visitor cookie of the browser that ran the
// check (`visitorHash`). `claim` turns a result into a resume in the
// signed-in user's account and answers the full report. Nothing here calls a model directly; the parser
// path may (structured parse) on RoboApply when its text model is on —
// never for a GoApply visitor (./parse.ts, `anonymousAiAllowed`).

import crypto from 'node:crypto';

import { HttpError } from '../../platform/http.js';
import { applyResumeUploadPolicy, goHireParseActive, isCn0 } from '../../platform/residency/index.js';
import {
  DAY,
  consumeRateLimit,
  hashIdentifier,
  rateLimitKey,
  rateLimitWindows,
  windowStartFor,
} from '../../platform/ratelimit/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { logger } from '../../services/LoggerService.js';
import type { GradeLabel, GradeProfile, KeywordReportResponse, KeywordReportRow } from '../resume/contract.js';
import {
  ResumeJobMatchFieldsSchema,
  TOOLS_ACCEPTED_EXTENSIONS,
  TOOLS_ACCEPTED_TYPES,
  TOOLS_CONSENT_VERSION,
  TOOLS_ERROR_REASONS,
  TOOLS_LIMITS,
  TOOLS_VISITOR_PATTERN,
  TOOL_KINDS,
  type ClaimToolResultResponse,
  type ResumeCheckReport,
  type ResumeJobMatchReport,
  type ToolIssue,
  type ToolKind,
  type ToolReport,
  type ToolsConfigView,
} from './contract.js';
import type { ChecklistResult } from './checks.js';
import type { ParseUpload } from './parse.js';
import {
  hashResultId,
  newResultId,
  sha256Hex,
  type RateCounterReader,
  type StoredCheckReport,
  type StoredMatchReport,
  type StoredReport,
  type ToolResultPayload,
  type ToolResultRow,
  type ToolsStore,
} from './store.js';

export const RATE_LIMIT_NAME = 'publicToolsPerIp' as const;
/** Limiter key name of the per-IP attempts guard (windows fixed here: TOOLS_LIMITS.attemptsPerIpPerDay a day). */
export const ATTEMPTS_KEY_NAME = 'publicToolsAttemptsPerIp' as const;

/** Named in GoApply's processing notice when GoHire's parse API is active for the brand (R-16). */
export const GOHIRE_PARSER_NAME = 'GoHire';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface RunInput {
  ip: string;
  /** The browser's visitor cookie (the route sets one when missing). */
  visitor: string;
  file: UploadedFile | null;
  fields: Record<string, unknown>;
  requestId?: string;
  signal?: AbortSignal;
}

export interface ToolsRate {
  /** Count one run of `kind`; `allowed=false` when today's allowance for it is used up. `limit` = the effective daily allowance. */
  consume(ip: string, brandId: string, now: Date, kind: ToolKind): Promise<{ allowed: boolean; retryAfterSec: number; limit?: number }>;
  /** Runs of `kind` left today (null when unreadable) and when the allowance resets. */
  remaining(ip: string, brandId: string, now: Date, kind: ToolKind): Promise<{ remaining: number | null; resetsAt: Date; limit?: number }>;
  /** Count one attempt against the per-IP attempts guard (both tools, cache hits too). */
  attempt(ip: string, brandId: string, now: Date): Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export interface CreateResumeResult {
  id: string;
}

export interface ToolsServiceDeps {
  store: ToolsStore;
  rate: ToolsRate;
  parse: ParseUpload;
  checklist: (markdown: string, profile: GradeProfile) => Promise<ChecklistResult>;
  requirementRows: (markdown: string, posting: { title: string; text: string }, profile: GradeProfile) => Promise<KeywordReportResponse>;
  /** Create a base resume in the user's account (RAResumeService). Throws `{ code: 'resume_limit' }` when the slots are full. */
  createResume: (userId: string, input: { name: string; markdown: string }) => Promise<CreateResumeResult>;
  brand: () => ProductBrand;
  env?: EnvSource;
  now?: () => Date;
  newResultId?: () => string;
}

export class ResumeLimitReachedError extends Error {
  readonly code = 'resume_limit' as const;
}

export interface ToolsService {
  config(ip: string): Promise<ToolsConfigView>;
  run(kind: ToolKind, input: RunInput): Promise<ToolReport>;
  /** `visitor` = the browser's visitor cookie (null when absent → 404 without a lookup). */
  getResult(rawId: string, visitor: string | null): Promise<ToolReport>;
  claim(user: { id: string; brand?: string | null }, rawId: string, visitor: string | null): Promise<ClaimToolResultResponse>;
  purge(brandId: string, now?: Date): Promise<number>;
}

const HOUR_MS = 3600_000;

/** sha256 of a visitor cookie (what a result row keeps). */
export function hashVisitor(visitor: string): string {
  return sha256Hex(`tools-visitor|${visitor}`);
}

/** A fresh visitor cookie value: 32 random bytes, base64url (43 characters). */
export function newVisitorId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function isVisitorId(value: unknown): value is string {
  return typeof value === 'string' && TOOLS_VISITOR_PATTERN.test(value);
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Whether the free tools are open for this brand and stage. GoApply in CN-0
 * (offshore, invite-only closed beta) is closed: an open anonymous upload
 * would send mainland visitors' resumes offshore outside the beta and its
 * separate cross-border consent (CN_TW_LAUNCH_PLAN §3, L-2). Opening it needs
 * counsel's sign-off and processor-naming copy (OPS-C).
 */
export function toolsOpen(brand: ProductBrand, env: EnvSource = process.env): boolean {
  return !(brand.market === 'cn' && isCn0(brand, env));
}

function disabled(): HttpError {
  return new HttpError('feature_disabled', 'These tools are not available here yet.');
}

function rateLimited(message: string, details: Record<string, unknown>, retryAfterSec: number): HttpError {
  return new HttpError('rate_limited', message, { retryAfterSec, ...details }, { 'Retry-After': String(retryAfterSec) });
}

function invalid(reason: string, message: string): HttpError {
  return new HttpError('invalid_request', message, { reason });
}

function extOf(name: string): string {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || '');
  return m ? m[0].toLowerCase() : '';
}

/** First bytes agree with the declared kind (a renamed image or binary is refused before any parse). */
export function looksLike(buffer: Buffer, ext: string, mime: string): boolean {
  const head = buffer.subarray(0, 8);
  if (ext === '.pdf' || mime === 'application/pdf') return head.subarray(0, 4).toString('latin1') === '%PDF';
  if (ext === '.docx' || mime.includes('openxmlformats')) return head[0] === 0x50 && head[1] === 0x4b;
  if (ext === '.doc' || mime === 'application/msword') return head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (ext === '.txt' || mime === 'text/plain') return !buffer.subarray(0, 4096).includes(0);
  return false;
}

/** 422 reasons for a file that cannot be checked, or null. */
export function fileProblem(file: UploadedFile | null): HttpError | null {
  if (!file || !file.buffer || file.size === 0 || file.buffer.byteLength === 0) {
    return invalid(TOOLS_ERROR_REASONS.missingFile, 'Choose a resume file.');
  }
  if (file.size > TOOLS_LIMITS.maxFileBytes || file.buffer.byteLength > TOOLS_LIMITS.maxFileBytes) {
    return invalid(TOOLS_ERROR_REASONS.tooLarge, 'The file is larger than 15 MB.');
  }
  const ext = extOf(file.originalname);
  const mime = (file.mimetype || '').toLowerCase();
  const declared = (TOOLS_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext) || (TOOLS_ACCEPTED_TYPES as readonly string[]).includes(mime);
  if (!declared || !looksLike(file.buffer, ext, mime)) {
    return invalid(TOOLS_ERROR_REASONS.wrongType, 'Use a PDF, Word or plain-text file.');
  }
  return null;
}

function postingFrom(fields: Record<string, unknown>): { title: string; text: string } {
  const title = typeof fields.postingTitle === 'string' ? fields.postingTitle.trim() : '';
  const text = typeof fields.postingText === 'string' ? fields.postingText.trim() : '';
  if (!title) throw invalid(TOOLS_ERROR_REASONS.postingTitleMissing, 'Add the job title.');
  if (text.length > TOOLS_LIMITS.postingMaxChars) throw invalid(TOOLS_ERROR_REASONS.postingTooLong, 'The job description is too long.');
  const parsed = ResumeJobMatchFieldsSchema.safeParse({ postingTitle: title, postingText: text });
  if (!parsed.success) {
    const titleIssue = parsed.error.issues.some((i) => i.path[0] === 'postingTitle');
    if (titleIssue) throw invalid(TOOLS_ERROR_REASONS.postingTitleMissing, 'Add the job title (up to 200 characters).');
    throw invalid(TOOLS_ERROR_REASONS.postingTooShort, 'Paste the full job description.');
  }
  return { title: parsed.data.postingTitle, text: parsed.data.postingText };
}

function toolIssue(issue: ChecklistResult['issues'][number]): ToolIssue {
  const { target: _t, fixable: _f, suggestion: _s, ...rest } = issue;
  return rest;
}

function checkView(report: StoredCheckReport, meta: { resultId: string; expiresAt: Date; cached: boolean; full: boolean }): ResumeCheckReport {
  const all = (report.issues as ToolIssue[]) ?? [];
  const shown = meta.full ? all : all.slice(0, TOOLS_LIMITS.shortReportIssues);
  return {
    kind: 'resume_check',
    resultId: meta.resultId,
    expiresAt: meta.expiresAt.toISOString(),
    cached: meta.cached,
    full: meta.full,
    label: report.label as GradeLabel,
    counts: report.counts,
    issues: shown,
    hiddenIssueCount: all.length - shown.length,
    rulesChecked: report.rulesChecked,
    profile: report.profile as GradeProfile,
    method: 'rules',
  };
}

function matchView(report: StoredMatchReport, meta: { resultId: string; expiresAt: Date; cached: boolean; full: boolean }): ResumeJobMatchReport {
  return {
    kind: 'resume_job_match',
    resultId: meta.resultId,
    expiresAt: meta.expiresAt.toISOString(),
    cached: meta.cached,
    full: meta.full,
    postingTitle: report.postingTitle,
    rows: report.rows as KeywordReportRow[],
    keywords: report.keywords,
    hardSkills: report.hardSkills,
    method: 'rules',
  };
}

export function viewOf(report: StoredReport, meta: { resultId: string; expiresAt: Date; cached: boolean; full: boolean }): ToolReport {
  return report.kind === 'resume_check' ? checkView(report, meta) : matchView(report, meta);
}

export function createToolsService(deps: ToolsServiceDeps): ToolsService {
  const now = deps.now ?? (() => new Date());
  const makeId = deps.newResultId ?? newResultId;
  const env = deps.env ?? process.env;

  const profileOf = (brand: ProductBrand): GradeProfile => (brand.market === 'cn' ? 'cn' : 'intl');
  /** Runs parsing right now on this instance, by brand|ipHash|kind. */
  const inFlight = new Set<string>();

  async function purgeQuietly(brandId: string, at: Date): Promise<void> {
    try {
      await deps.store.purgeExpired(brandId, at);
    } catch (err) {
      logger.warn('TOOLS', 'expired tool results could not be purged (jobs-maintain retries)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** A result of this brand, run in this browser, still inside its 24 h. Anything else is the same 404. */
  async function liveRow(rawId: string, visitor: string | null, brand: ProductBrand, at: Date): Promise<ToolResultRow> {
    // No visitor cookie → nothing to look up (a result id alone opens nothing).
    if (!isVisitorId(visitor) || typeof rawId !== 'string' || !rawId) throw new HttpError('not_found', 'This result was not found.');
    const row = await deps.store.findByTokenHash(brand.id, hashResultId(rawId));
    if (!row || row.brand !== brand.id || !sameHash(row.payload.visitorHash, hashVisitor(visitor))) {
      throw new HttpError('not_found', 'This result was not found.');
    }
    if (row.expiresAt.getTime() <= at.getTime()) {
      throw new HttpError('not_found', 'This result was deleted after 24 hours.', { reason: TOOLS_ERROR_REASONS.resultExpired });
    }
    return row;
  }

  return {
    async config(ip) {
      const brand = deps.brand();
      const at = now();
      const available = toolsOpen(brand, env);
      const remainingByTool = { resume_check: null, resume_job_match: null } as Record<ToolKind, number | null>;
      let limit: number = TOOLS_LIMITS.perIpPerDay;
      let resetsAt = new Date(windowStartFor(at, DAY).getTime() + DAY * 1000);
      if (available) {
        for (const kind of TOOL_KINDS) {
          try {
            const r = await deps.rate.remaining(ip, brand.id, at, kind);
            remainingByTool[kind] = r.remaining;
            resetsAt = r.resetsAt;
            if (typeof r.limit === 'number') limit = r.limit;
          } catch (err) {
            logger.warn('TOOLS', 'tool allowance could not be read', { kind, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      const cn = brand.market === 'cn';
      return {
        available,
        perIpPerDay: limit,
        remainingByTool,
        resetsAt: resetsAt.toISOString(),
        maxFileBytes: TOOLS_LIMITS.maxFileBytes,
        acceptedTypes: [...TOOLS_ACCEPTED_TYPES],
        acceptedExtensions: [...TOOLS_ACCEPTED_EXTENSIONS],
        cacheHours: TOOLS_LIMITS.cacheHours,
        shortReportIssues: TOOLS_LIMITS.shortReportIssues,
        consentRequired: cn,
        consentVersion: cn ? TOOLS_CONSENT_VERSION : null,
        processedOutsideMainland: cn && isCn0(brand, env),
        parserName: cn && goHireParseActive(brand, env) ? GOHIRE_PARSER_NAME : null,
      };
    },

    async run(kind, input) {
      const brand = deps.brand();
      if (!toolsOpen(brand, env)) throw disabled();
      const problem = fileProblem(input.file);
      if (problem) throw problem;
      const file = input.file!;
      const posting = kind === 'resume_job_match' ? postingFrom(input.fields) : null;
      const cn = brand.market === 'cn';
      if (cn && input.fields.consent !== TOOLS_CONSENT_VERSION) {
        throw invalid(TOOLS_ERROR_REASONS.consentRequired, 'Tick the box to let us read this resume.');
      }
      if (!isVisitorId(input.visitor)) throw new HttpError('invalid_request', 'Reload the page and try again.');

      const at = now();
      const failClosed = (what: string, err: unknown): HttpError => {
        // Fail closed: a run costs a parse, so an unmetered path is not acceptable.
        logger.error('TOOLS', `${what} failed (fail closed)`, { error: err instanceof Error ? err.message : String(err) });
        return rateLimited('Try again in a minute.', {}, 60);
      };

      let attempt: { allowed: boolean; retryAfterSec: number };
      try {
        attempt = await deps.rate.attempt(input.ip, brand.id, at);
      } catch (err) {
        throw failClosed('tool attempts guard', err);
      }
      if (!attempt.allowed) {
        throw rateLimited('Too many tries today. Try again tomorrow.', { reason: TOOLS_ERROR_REASONS.tooManyAttempts }, attempt.retryAfterSec);
      }

      const ipHash = hashIdentifier(input.ip);
      const visitorHash = hashVisitor(input.visitor);
      const postingHash = posting ? sha256Hex(`${posting.title}\n${posting.text}`) : '-';
      // The leading version changes whenever a report for the same file would
      // read differently, so no visitor is handed a stored answer from the
      // older reading (v3: roles and dates of an uploaded file reach the rows).
      const cacheKey = sha256Hex(`v3|${brand.id}|${kind}|${sha256Hex(file.buffer)}|${postingHash}|${ipHash}|${visitorHash}`);

      const cached = await deps.store.findByCacheKey(brand.id, cacheKey, at);
      if (cached && cached.payload.tool === kind && sameHash(cached.payload.visitorHash, visitorHash)) {
        // A fresh id for this answer; ids handed out earlier for the row stay valid.
        const rawId = makeId();
        await deps.store.addTokenAlias(cached, hashResultId(rawId));
        return viewOf(cached.payload.report, { resultId: rawId, expiresAt: cached.expiresAt, cached: true, full: false });
      }

      // None left today → refuse before any parse.
      let left: { remaining: number | null; limit?: number; resetsAt: Date };
      try {
        left = await deps.rate.remaining(input.ip, brand.id, at, kind);
      } catch (err) {
        throw failClosed('tool allowance read', err);
      }
      const usedUp = (limit: number | undefined, retryAfterSec: number) => {
        const effective = typeof limit === 'number' ? limit : TOOLS_LIMITS.perIpPerDay;
        return rateLimited(`You have used today's ${effective} free checks of this tool.`, { limit: effective }, retryAfterSec);
      };
      if (left.remaining === null) throw failClosed('tool allowance read', new Error('unreadable'));
      if (left.remaining <= 0) {
        throw usedUp(left.limit, Math.max(1, Math.ceil((left.resetsAt.getTime() - at.getTime()) / 1000)));
      }

      // One run per visitor and tool at a time on this instance.
      const flightKey = `${brand.id}|${ipHash}|${kind}`;
      if (inFlight.has(flightKey)) {
        throw rateLimited('A check is already running. Wait for it to finish.', { reason: TOOLS_ERROR_REASONS.runInProgress }, 10);
      }
      inFlight.add(flightKey);
      try {
        // An unreadable file throws here (422 file_unreadable) and uses no check.
        const parsed = await deps.parse({
          buffer: file.buffer,
          fileName: file.originalname,
          mimeType: file.mimetype,
          brand,
          requestId: input.requestId,
          signal: input.signal,
        });

        let allowed: { allowed: boolean; retryAfterSec: number; limit?: number };
        try {
          allowed = await deps.rate.consume(input.ip, brand.id, at, kind);
        } catch (err) {
          throw failClosed('tool allowance check', err);
        }
        if (!allowed.allowed) throw usedUp(allowed.limit, allowed.retryAfterSec);

        const profile = profileOf(brand);
        let report: StoredReport;
        if (kind === 'resume_check') {
          const c = await deps.checklist(parsed.markdown, profile);
          report = { kind, label: c.label, counts: c.counts, issues: c.issues.map(toolIssue), rulesChecked: c.rulesChecked, profile: c.profile };
        } else {
          const k = await deps.requirementRows(parsed.markdown, posting!, profile);
          report = { kind, postingTitle: posting!.title, rows: k.rows, keywords: k.keywords, hardSkills: k.hardSkills };
        }

        // Brand storage rule before anything is kept (CN-0 GoApply: redact IDs and health details).
        const applied = applyResumeUploadPolicy(brand, { rawText: '', markdown: parsed.markdown, parsed: report }, env);
        const payload: ToolResultPayload = {
          v: 1,
          tool: kind,
          cacheKey,
          report: (applied.parsed ?? report) as StoredReport,
          resume: { markdown: applied.markdown ?? parsed.markdown, name: parsed.name },
          visitorHash,
          ...(cn ? { consent: { version: TOOLS_CONSENT_VERSION, at: at.toISOString() } } : {}),
        };
        const rawId = makeId();
        const expiresAt = new Date(at.getTime() + TOOLS_LIMITS.cacheHours * HOUR_MS);
        await deps.store.create({ brand: brand.id, tokenHash: hashResultId(rawId), payload, expiresAt });
        await purgeQuietly(brand.id, at);

        return viewOf(payload.report, { resultId: rawId, expiresAt, cached: false, full: false });
      } finally {
        inFlight.delete(flightKey);
      }
    },

    async getResult(rawId, visitor) {
      const brand = deps.brand();
      if (!toolsOpen(brand, env)) throw disabled();
      const at = now();
      const row = await liveRow(rawId, visitor, brand, at);
      if (row.consumedAt) {
        throw new HttpError('not_found', 'This result was saved to an account.', { reason: TOOLS_ERROR_REASONS.resultClaimed });
      }
      return viewOf(row.payload.report, { resultId: rawId, expiresAt: row.expiresAt, cached: true, full: false });
    },

    async claim(user, rawId, visitor) {
      const brand = deps.brand();
      if (!toolsOpen(brand, env)) throw disabled();
      if (user.brand && user.brand !== brand.id) throw new HttpError('not_found', 'This result was not found.');
      const at = now();
      const row = await liveRow(rawId, visitor, brand, at);
      const full = (r: ToolResultRow) => viewOf(r.payload.report, { resultId: rawId, expiresAt: r.expiresAt, cached: true, full: true });

      const repeat = (r: ToolResultRow): ClaimToolResultResponse => {
        if (r.userId === user.id && r.payload.claimedResumeId) {
          return { resumeId: r.payload.claimedResumeId, report: full(r), alreadyClaimed: true };
        }
        throw new HttpError('not_found', 'This result was not found.');
      };
      if (row.consumedAt) return repeat(row);
      if (!row.payload.resume) throw new HttpError('not_found', 'This result was not found.');

      if (!(await deps.store.markClaimed(row.id, user.id, at))) {
        const again = await deps.store.findByTokenHash(brand.id, row.tokenHash);
        if (again?.consumedAt) return repeat(again);
        throw new HttpError('conflict', 'This result is being saved. Try again.');
      }

      let created: CreateResumeResult;
      try {
        created = await deps.createResume(user.id, { name: row.payload.resume.name, markdown: row.payload.resume.markdown });
      } catch (err) {
        await deps.store.unclaim(row.id).catch(() => undefined);
        if ((err as { code?: unknown })?.code === 'resume_limit') {
          throw new HttpError('conflict', 'You already have the most resumes your account can hold. Delete one, then try again.', {
            reason: TOOLS_ERROR_REASONS.resumeLimit,
          });
        }
        throw err;
      }

      // The text now lives in the account; the cache row keeps only the report until it expires.
      const payload: ToolResultPayload = { ...row.payload, resume: null, claimedResumeId: created.id };
      try {
        await deps.store.savePayload(row.id, payload);
      } catch (err) {
        logger.warn('TOOLS', 'claimed tool result could not be trimmed (purged at expiry)', { error: err instanceof Error ? err.message : String(err) });
      }
      return { resumeId: created.id, report: full({ ...row, payload }), alreadyClaimed: false };
    },

    async purge(brandId, at = now()) {
      return deps.store.purgeExpired(brandId, at);
    },
  };
}

// ── Production allowance (platform limiter, `publicToolsPerIp`) ──────────

export interface ToolsRateDeps {
  reader: RateCounterReader;
  consume?: typeof consumeRateLimit;
  env?: EnvSource;
}

/** Counter identifier of one tool's allowance: the IP and the tool (hashed into the key by the limiter). */
function toolIdentifier(ip: string, kind: ToolKind): string {
  return `${ip}|${kind}`;
}

/**
 * The persisted allowance on RARateCounter (same keys as the platform
 * limiter): `publicToolsPerIp` per IP and per tool (3 a day each, PRODUCT
 * limits; RATE_LIMITS_JSON may change it), plus the attempts guard
 * (`publicToolsAttemptsPerIp`, TOOLS_LIMITS.attemptsPerIpPerDay a day per IP).
 */
export function createToolsRate(deps: ToolsRateDeps): ToolsRate {
  const consume = deps.consume ?? consumeRateLimit;
  const windows = () => rateLimitWindows(RATE_LIMIT_NAME, deps.env ?? process.env);
  return {
    async consume(ip, brandId, at, kind) {
      const ws = windows();
      const r = await consume({ key: rateLimitKey(RATE_LIMIT_NAME, 'ip', toolIdentifier(ip, kind), brandId), windows: ws, now: at });
      return { allowed: r.allowed, retryAfterSec: r.retryAfterSec, limit: Math.min(...ws.map((w) => w.limit)) };
    },
    async remaining(ip, brandId, at, kind) {
      const key = rateLimitKey(RATE_LIMIT_NAME, 'ip', toolIdentifier(ip, kind), brandId);
      const ws = windows();
      const reads = ws.map((w) => ({ key: `${key}:${w.windowSec}`, windowStart: windowStartFor(at, w.windowSec) }));
      const counts = await deps.reader.counts(reads);
      const remaining = Math.max(0, Math.min(...ws.map((w, i) => w.limit - (counts[i] ?? 0))));
      const resetsAt = new Date(Math.max(...ws.map((w, i) => reads[i]!.windowStart.getTime() + w.windowSec * 1000)));
      const limit = Math.min(...ws.map((w) => w.limit));
      return { remaining, resetsAt, limit };
    },
    async attempt(ip, brandId, at) {
      const r = await consume({
        key: rateLimitKey(ATTEMPTS_KEY_NAME, 'ip', ip, brandId),
        windows: [{ limit: TOOLS_LIMITS.attemptsPerIpPerDay, windowSec: DAY }],
        now: at,
      });
      return { allowed: r.allowed, retryAfterSec: r.retryAfterSec };
    },
  };
}
