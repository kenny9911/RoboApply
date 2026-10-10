// server/src/features/extension/service.ts — the extension's server side
// (ARCHITECTURE.md §3.8, §6; TASK_PLAN.md WP-55a).
//
// Rules this service enforces (each has a test in service.test.ts):
//   - D1: nothing here submits, clicks or watches an employer form. A run is
//     marked submitted only when the user answers "Did you submit this
//     application?" (PATCH userMarkedSubmitted), and only then the tracker
//     entry moves to Applied (`via: 'extension'`).
//   - Protected question types (work authorization, sponsorship, criminal
//     history, EEO / disability / veteran, personal facts, salary history or
//     expectation, years of experience, degrees, certifications, clearance,
//     notice period) never get `source: 'ai'`: they come from the answer
//     bank, or nothing. A bank answer is reused for a protected question only
//     for the same question and the same country (questionTypes.ts).
//   - AI drafts only with `aiAllowed(user)` and the brand's text model; the
//     prompt context is `profileSnapshotForLlm()` only; one `ai_answer` credit
//     per draft; bank hits are free. GoApply WeChat accounts need a phone.
//   - Page-job fit runs only when the extension calls it (a user click): there
//     is no page-load trigger anywhere in this area.
//   - Saved jobs are private imports (`visibility: 'private'`) through the job
//     import service: never counted, never shown publicly.
//   - Autofill runs reserve one `autofill` credit; it is committed only when
//     at least one field was filled, otherwise released. A run released on a
//     "nothing filled" report that later reports filled fields is charged
//     once (a fresh credit keyed to the run); `charged` always reflects the
//     ledger, never a guess from the run row.
//   - Sensitive answers leave only with a live `autofill_sensitive` consent:
//     `sensitiveAnswersForAutofill()` (the profile's encrypted store) and
//     answer-bank entries that are sensitive (EEO, disability, veteran,
//     personal facts, CN 政治面貌 / 家庭成员 / 籍贯 …). Never into a prompt.

import crypto from 'node:crypto';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { brandEnv } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { CreditReplayError, type CreditService } from '../../platform/credits/index.js';
import { logger } from '../../services/LoggerService.js';
import {
  type AnswerQuestionResponse,
  type AutofillProfile,
  type CreateAutofillRunResponse,
  type CreateDeviceResponse,
  type DeviceView,
  EXTENSION_ERROR_CODES,
  type ExtMeResponse,
  type ExtStatusResponse,
  PAIR_CODE_TTL_MS,
  type PageJobResponse,
  type PairCodeResponse,
  type PatchAutofillRunResponse,
  type ResumeForJobResponse,
  type SaveJobResponse,
} from './contract.js';
import type { z } from 'zod';
import type {
  AnswerQuestionBodySchema,
  CreateAutofillRunBodySchema,
  CreateDeviceBodySchema,
  PageJobBodySchema,
  PatchAutofillRunBodySchema,
  RedeemPairCodeBodySchema,
  ResumeForJobBodySchema,
  SaveJobBodySchema,
  SiteRequestBodySchema,
  UninstallSurveyBodySchema,
} from './contract.js';
import { classifyQuestion, draftableLanguage, findBankAnswer, isProtectedQuestionType, isSensitiveBankEntry, normalizeQuestion, type BankEntry } from './questionTypes.js';
import type { DeviceRow, ExtJobRow, ExtensionRepo, RunRow } from './repository.js';
import { hashPairCode, issueDeviceToken, newPairCode, sha256Hex, signFileToken, verifyFileToken } from './tokens.js';

type Body<S extends z.ZodType> = z.infer<S>;

/** The parts of the user's profile this area reads (profile area seam, WP-19). */
export interface ExtProfileView {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  headline: string | null;
  contactEmail: string | null;
  phoneE164: string | null;
  phoneType: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  links: Record<string, string | undefined>;
  summary: string | null;
  skills: Array<{ name: string }>;
  languages: Array<{ language: string; level: string }>;
  workAuth: Array<{ country: string; authorized: boolean | null; sponsorship: 'now' | 'later' | 'no' | null }>;
  cnFields: Record<string, unknown> | null;
  twFields: unknown;
  education: Array<object>;
  experience: Array<object>;
  completeness: number;
}

export type FitChip = NonNullable<PageJobResponse['fit']>;

export interface PageForFit {
  url: string;
  title: string;
  company: string;
  location: string | null;
  descriptionText: string;
}

export interface ExportedFile {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  artifactId: string | null;
}

export interface ExtensionDeps {
  repo: ExtensionRepo;
  now: () => Date;
  env: EnvSource;
  /** The brand of the current request. */
  brand: () => ProductBrand;
  credits: Pick<CreditService, 'reserve' | 'commit' | 'release' | 'withCredit'>;
  profile: {
    get(userId: string): Promise<ExtProfileView>;
    snapshotText(userId: string): Promise<string>;
    /** Null without a live `autofill_sensitive` consent (or when nothing is stored). */
    sensitiveForAutofill(userId: string): Promise<Record<string, unknown> | null>;
    /** A live `autofill_sensitive` consent (gates sensitive answer-bank entries). */
    sensitiveConsent(userId: string): Promise<boolean>;
  };
  /** The user's answer bank (Ready to apply, WP-52). */
  answerBank(userId: string): Promise<BankEntry[]>;
  /** Tell Ready to apply the user says they submitted (D1: the only signal). */
  markAgentSubmitted(userId: string, jobId: string): Promise<void>;
  entitlements(userId: string): Promise<unknown>;
  flags(userId: string): Promise<Record<string, unknown>>;
  match: {
    /** A cached AI score, otherwise the deterministic estimate (never calls a model). */
    cached(userId: string, jobId: string): Promise<FitChip | null>;
    /** The deterministic estimate for a page that is not one of our jobs. */
    page(userId: string, page: PageForFit): Promise<FitChip | null>;
  };
  saveImportedJob(
    userId: string,
    fields: { title: string; company: string; description: string; applyUrl?: string; location?: string },
    options: { idempotencyKey: string | null },
  ): Promise<{ jobId: string | null; matched: 'public' | 'yours' | null }>;
  tracker: {
    /** Saved (or already further along); returns the entry id. */
    saveForJob(userId: string, jobId: string): Promise<string>;
    markApplied(userId: string, jobId: string): Promise<{ entryId: string; changed: boolean }>;
  };
  recordInteraction(userId: string, jobId: string, kind: 'save' | 'applied'): Promise<void>;
  /** 'ok' or why AI is off for this user (aiAllowed, then the brand's text model). */
  aiAvailability(userId: string): Promise<'ok' | 'ai_off' | 'ai_unavailable'>;
  /** GoApply: WeChat accounts without a verified phone answer 403 phone_binding_required. */
  assertPhoneBound(userId: string): Promise<void>;
  draftAnswer(input: { question: string; maxLength: number; profileText: string; job: { title: string; company: string } | null; brand: ProductBrand }): Promise<string>;
  logAiLabel(userId: string, runId: string): Promise<void>;
  unverifiedClaims(variantId: string): Promise<number>;
  /** `trackerEntryId` null: no application to record the file on (artifactId comes back null). */
  exportResume(userId: string, variantId: string, options: { trackerEntryId: string | null; brand: ProductBrand }): Promise<ExportedFile>;
  /** cn: the visibility rule for third-party postings (mode off hides them). */
  cnPostingVisible(job: ExtJobRow, userId: string): boolean;
  cnWhere(userId: string): { OR: Array<Record<string, unknown>> };
}

const AI_ANSWER_DEFAULT_MAX = 1500;

function toDeviceView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    name: row.name,
    browser: row.browser,
    extVersion: row.extVersion,
    tokenPrefix: row.tokenPrefix,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function runNotFound(): HttpError {
  return new HttpError('not_found', 'This fill run was not found.', { reason: EXTENSION_ERROR_CODES.runNotFound });
}

function soft(what: string, p: Promise<unknown>): Promise<void> {
  return p.then(
    () => undefined,
    (err) => {
      logger.warn('EXTENSION', `${what} failed (ignored)`, { error: err instanceof Error ? err.message : String(err) });
    },
  );
}

/** URL without query string and fragment (the part that can carry personal details). */
export function pageUrlWithoutQuery(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** The model returned nothing usable; thrown inside `withCredit` so the `ai_answer` reservation is released. */
class EmptyDraftError extends Error {
  constructor() {
    super('empty AI draft');
    this.name = 'EmptyDraftError';
  }
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

export function createExtensionService(deps: ExtensionDeps) {
  const brandId = () => deps.brand().id;

  function minExtVersion(): string | null {
    return brandEnv(deps.brand(), 'MIN_EXT_VERSION', deps.env)?.trim() || null;
  }

  /** May this user see this job in this market (the user's own import, or a live public posting)? */
  function visible(job: ExtJobRow | null, userId: string): job is ExtJobRow {
    if (!job || job.archivedAt) return false;
    if (job.market !== deps.brand().market) return false;
    if (job.visibility !== 'public' && job.ownerUserId !== userId) return false;
    return deps.cnPostingVisible(job, userId);
  }

  async function newDevice(userId: string, info: { name: string; browser?: string; extVersion?: string }): Promise<CreateDeviceResponse> {
    const issued = issueDeviceToken();
    const row = await deps.repo.createDevice({
      userId,
      brand: brandId(),
      tokenHash: issued.tokenHash,
      tokenPrefix: issued.tokenPrefix,
      name: info.name,
      browser: info.browser ?? null,
      extVersion: info.extVersion ?? null,
    });
    logger.info('EXTENSION', 'device paired', { userId, deviceId: row.id, brand: row.brand });
    return { deviceId: row.id, token: issued.token };
  }

  async function ownRun(userId: string, runId: string): Promise<RunRow> {
    const run = await deps.repo.getRun(userId, runId);
    if (!run) throw runNotFound();
    return run;
  }

  /**
   * One `autofill` credit for a run that filled at least one field; true once
   * it is spent. Every call reads the truth from the ledger: committing a
   * committed reservation is a no-op, so repeated reports never charge twice.
   * When the run's reservation was already released (an earlier "nothing
   * filled" report, or the stale-reservation cron), one fresh credit keyed to
   * the run is reserved and committed instead (idempotent on that key).
   */
  async function chargeRun(userId: string, run: RunRow): Promise<boolean> {
    try {
      const settled = await deps.credits.commit(run.creditLedgerId!, { refId: run.id });
      if (settled.status === 'committed') return true;
    } catch {
      // Released before: fall through to a late charge.
    }
    try {
      const late = await deps.credits.reserve({ userId, bucket: 'autofill', idempotencyKey: `ext-run-late:${run.id}`, refType: 'autofill_run', refId: run.id, brand: brandId() });
      const settled = await deps.credits.commit(late.id, { refId: run.id });
      return settled.status === 'committed';
    } catch (err) {
      // Out of credits now: the fill already happened in the browser; record the run, report not charged.
      logger.warn('EXTENSION', 'late autofill charge failed', { runId: run.id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  return {
    // ── Pairing and devices (session) ─────────────────────────────────────

    createDevice(userId: string, body: Body<typeof CreateDeviceBodySchema>): Promise<CreateDeviceResponse> {
      return newDevice(userId, body);
    },

    async listDevices(userId: string): Promise<DeviceView[]> {
      return (await deps.repo.listDevices(userId, brandId())).map(toDeviceView);
    },

    async status(userId: string): Promise<ExtStatusResponse> {
      const devices = (await deps.repo.listDevices(userId, brandId())).map(toDeviceView);
      return { minExtVersion: minExtVersion(), devices };
    },

    async revokeDevice(userId: string, id: string): Promise<void> {
      const done = await deps.repo.revokeDevice(userId, brandId(), id, deps.now());
      if (!done) throw new HttpError('not_found');
      logger.info('EXTENSION', 'device revoked', { userId, deviceId: id });
    },

    async createPairCode(userId: string): Promise<PairCodeResponse> {
      const code = newPairCode();
      const expiresAt = new Date(deps.now().getTime() + PAIR_CODE_TTL_MS);
      await deps.repo.createPairCode({ userId, brand: brandId(), tokenHash: hashPairCode(brandId(), code), expiresAt });
      return { code, expiresAt: expiresAt.toISOString() };
    },

    async redeemPairCode(body: Body<typeof RedeemPairCodeBodySchema>): Promise<CreateDeviceResponse> {
      const invalid = () => new HttpError('not_found', 'This code is not valid any more. Make a new one on the extension page.', { reason: EXTENSION_ERROR_CODES.pairCodeInvalid });
      const claimed = await deps.repo.consumePairCode(hashPairCode(brandId(), body.code), brandId(), deps.now());
      if (!claimed) throw invalid();
      const user = await deps.repo.userBrand(claimed.userId);
      if (!user || !user.isActive || user.brand !== brandId()) throw invalid();
      return newDevice(claimed.userId, { name: body.name, browser: body.browser, extVersion: body.extVersion });
    },

    // ── Device routes ────────────────────────────────────────────────────

    async me(userId: string): Promise<ExtMeResponse> {
      const brand = deps.brand();
      const [user, profile, entitlements, flags] = await Promise.all([
        deps.repo.userBrand(userId),
        deps.profile.get(userId).catch(() => null),
        deps.entitlements(userId),
        deps.flags(userId),
      ]);
      return {
        user: { id: userId, email: user?.email ?? null, firstName: profile?.firstName ?? null },
        brand: { id: brand.id, name: brand.name },
        entitlements,
        flags,
        profileCompleteness: profile ? Math.max(0, Math.min(100, Math.round(profile.completeness))) : null,
        minExtVersion: minExtVersion(),
      };
    },

    async autofillProfile(userId: string): Promise<AutofillProfile> {
      const [p, user, bank, sensitive, consent] = await Promise.all([
        deps.profile.get(userId),
        deps.repo.userBrand(userId),
        deps.answerBank(userId),
        deps.profile.sensitiveForAutofill(userId),
        deps.profile.sensitiveConsent(userId),
      ]);
      const links: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.links ?? {})) if (typeof v === 'string' && v) links[k] = v;
      return {
        profile: {
          firstName: p.firstName,
          middleName: p.middleName,
          lastName: p.lastName,
          headline: p.headline,
          email: p.contactEmail ?? user?.email ?? null,
          phone: p.phoneE164,
          phoneType: p.phoneType,
          addressLine1: p.addressLine1,
          city: p.city,
          region: p.region,
          postalCode: p.postalCode,
          country: p.country,
          summary: p.summary,
          skills: p.skills.map((s) => s.name),
          languages: p.languages,
          cnFields: p.cnFields,
          twFields: p.twFields ?? null,
        },
        education: p.education as Array<Record<string, unknown>>,
        experience: p.experience as Array<Record<string, unknown>>,
        links,
        workAuth: p.workAuth.map((w) => ({ country: w.country, authorized: w.authorized, sponsorship: w.sponsorship })),
        // Sensitive saved answers only with the `autofill_sensitive` consent (ARCH §3.8, §6.4).
        answers: bank
          .filter((b) => b.answer.trim() && (consent || !isSensitiveBankEntry(b)))
          .map((b) => ({ questionKey: b.questionKey, questionText: b.questionText, answer: b.answer })),
        sensitive: sensitive && Object.keys(sensitive).length ? sensitive : null,
      };
    },

    /** Fit for the page the user is looking at. Called only on the user's click. */
    async pageJob(userId: string, body: Body<typeof PageJobBodySchema>): Promise<PageJobResponse> {
      const brand = deps.brand();
      const stripped = pageUrlWithoutQuery(body.url);
      const job = await deps.repo.findJobByUrls({
        market: brand.market,
        userId,
        urls: [body.url, ...(stripped ? [stripped] : [])],
        cnWhere: brand.market === 'cn' ? deps.cnWhere(userId) : null,
      });
      if (visible(job, userId)) return { jobId: job.id, fit: await deps.match.cached(userId, job.id) };
      const fit = await deps.match.page(userId, {
        url: body.url,
        title: body.title,
        company: body.company,
        location: body.location ?? null,
        descriptionText: body.descriptionText,
      });
      return { jobId: null, fit };
    },

    /** "Save": a private import (never public, never counted) + a Saved tracker entry. */
    async saveJob(userId: string, body: Body<typeof SaveJobBodySchema>, idempotencyKey: string | null): Promise<SaveJobResponse> {
      const fields = {
        title: body.title,
        company: body.company,
        description: body.descriptionText.trim(),
        applyUrl: body.url,
        ...(body.location ? { location: body.location } : {}),
      };
      const saved = await deps.saveImportedJob(userId, fields, { idempotencyKey });
      if (!saved.jobId) throw new HttpError('conflict', 'This job could not be saved. Try again.');
      const trackerEntryId = await deps.tracker.saveForJob(userId, saved.jobId);
      await soft('feed affinity (save)', deps.recordInteraction(userId, saved.jobId, 'save'));
      return { jobId: saved.jobId, trackerEntryId, matched: saved.matched };
    },

    /** Start a run: reserves one `autofill` credit (committed only when a field gets filled). */
    async createRun(userId: string, deviceId: string, body: Body<typeof CreateAutofillRunBodySchema>, idempotencyKey: string | null): Promise<CreateAutofillRunResponse> {
      const brand = deps.brand();
      let job: ExtJobRow | null = body.jobId ? await deps.repo.loadJob(body.jobId) : null;
      if (!visible(job, userId)) {
        const stripped = pageUrlWithoutQuery(body.url);
        job = await deps.repo.findJobByUrls({
          market: brand.market,
          userId,
          urls: [body.url, ...(stripped ? [stripped] : [])],
          cnWhere: brand.market === 'cn' ? deps.cnWhere(userId) : null,
        });
        if (!visible(job, userId)) job = null;
      }
      const jobId = job?.id ?? null;
      const trackerEntryId = jobId ? await deps.repo.trackerEntryFor(userId, jobId) : null;

      const reservation = await deps.credits.reserve({
        userId,
        bucket: 'autofill',
        idempotencyKey: idempotencyKey?.trim() || `ext-run:${crypto.randomUUID()}`,
        refType: 'autofill_run',
        brand: brand.id,
      });
      if (reservation.replayed) {
        const existing = await deps.repo.findRunByLedger(userId, reservation.id);
        if (existing) return { runId: existing.id, jobId: existing.jobId };
      }
      try {
        const run = await deps.repo.createRun({
          userId,
          deviceId,
          jobId,
          trackerEntryId,
          host: body.host.toLowerCase(),
          atsType: body.atsType,
          fieldsTotal: body.fieldsTotal,
          creditLedgerId: reservation.id,
        });
        return { runId: run.id, jobId };
      } catch (err) {
        if (!reservation.replayed) await soft('release autofill reservation', deps.credits.release(reservation.id, 'run_not_created'));
        throw err;
      }
    },

    async patchRun(userId: string, runId: string, body: Body<typeof PatchAutofillRunBodySchema>): Promise<PatchAutofillRunResponse> {
      const run = await ownRun(userId, runId);
      const fieldsFilled = Math.max(run.fieldsFilled, body.fieldsFilled);
      let charged = false;
      if (run.creditLedgerId) {
        if (fieldsFilled > 0) charged = await chargeRun(userId, run);
        else if (run.outcome === 'started') await soft('release autofill reservation', deps.credits.release(run.creditLedgerId, 'nothing_filled'));
      }

      let trackerEntryId = run.trackerEntryId;
      let alreadyApplied = run.userMarkedSubmitted;
      let userMarkedSubmitted = run.userMarkedSubmitted;
      // D1: the user's own answer to "Did you submit this application?" is the only signal.
      if (body.userMarkedSubmitted === true && !run.userMarkedSubmitted) {
        userMarkedSubmitted = true;
        if (run.jobId) {
          const mark = await deps.tracker.markApplied(userId, run.jobId);
          trackerEntryId = mark.entryId;
          alreadyApplied = !mark.changed;
          await soft('feed affinity (applied)', deps.recordInteraction(userId, run.jobId, 'applied'));
          await soft('ready-to-apply submitted mark', deps.markAgentSubmitted(userId, run.jobId));
        } else {
          alreadyApplied = false;
        }
      }

      const updated = await deps.repo.updateRun(run.id, { fieldsFilled, outcome: body.outcome, userMarkedSubmitted, trackerEntryId });
      return {
        runId: updated.id,
        outcome: body.outcome,
        fieldsFilled: updated.fieldsFilled,
        charged,
        userMarkedSubmitted: updated.userMarkedSubmitted,
        trackerEntryId: updated.trackerEntryId,
        alreadyApplied,
      };
    },

    /**
     * One answer for one question. Order: the user's bank (free) → nothing for
     * a protected type or a choice field → an AI draft (one `ai_answer`).
     */
    async answer(userId: string, body: Body<typeof AnswerQuestionBodySchema>, idempotencyKey: string | null): Promise<AnswerQuestionResponse> {
      const run = await ownRun(userId, body.runId);
      const questionType = classifyQuestion(body.question);
      const max = body.maxLength ?? AI_ANSWER_DEFAULT_MAX;
      const none = (reason: AnswerQuestionResponse['reason']): AnswerQuestionResponse => ({ answer: null, source: 'none', saveable: false, questionType, reason });

      const bank = await deps.answerBank(userId);
      const hit = findBankAnswer(bank, body.question, questionType);
      // A sensitive saved answer (or a sensitive question) needs the `autofill_sensitive` consent.
      const sensitive = hit && (isSensitiveBankEntry(hit) || isSensitiveBankEntry({ questionKey: '', questionText: body.question }));
      if (hit && (!sensitive || (await deps.profile.sensitiveConsent(userId)))) {
        return { answer: clip(hit.answer, max), source: 'bank', saveable: false, questionType, reason: null };
      }

      // Facts about the person are never written by a model (ruling H2).
      if (isProtectedQuestionType(questionType)) return none('protected');
      if (body.fieldType !== 'text' && body.fieldType !== 'textarea') return none('choice_field');
      // The rules cannot vouch for a question in another language: no draft (fails closed).
      if (!draftableLanguage(body.question)) return none('unsupported_language');

      const availability = await deps.aiAvailability(userId);
      if (availability !== 'ok') return none(availability);
      const brand = deps.brand();
      if (brand.market === 'cn') await deps.assertPhoneBound(userId);

      const job = run.jobId ? await deps.repo.loadJob(run.jobId) : null;
      const key = idempotencyKey?.trim() || `ext-answer:${run.id}:${sha256Hex(normalizeQuestion(body.question)).slice(0, 16)}:${crypto.randomUUID()}`;
      let answer: string;
      try {
        answer = await deps.credits.withCredit(
          { userId, bucket: 'ai_answer', idempotencyKey: key, refType: 'autofill_answer', refId: run.id, brand: brand.id },
          async () => {
            const profileText = await deps.profile.snapshotText(userId);
            const text = await deps.draftAnswer({
              question: body.question,
              maxLength: max,
              profileText,
              job: visible(job, userId) ? { title: job.title, company: job.companyName } : null,
              brand,
            });
            const clipped = clip(text ?? '', max);
            // Throwing releases the reservation: an empty draft is not charged.
            if (!clipped) throw new EmptyDraftError();
            return clipped;
          },
        );
      } catch (err) {
        if (err instanceof EmptyDraftError) return none('empty');
        if (err instanceof CreditReplayError) throw new HttpError('conflict', 'This answer was already requested.', { reason: err.code });
        throw err;
      }
      await soft('ai answer count', deps.repo.incrementAiAnswers(run.id));
      await soft('ai label log', deps.logAiLabel(userId, run.id));
      return { answer, source: 'ai', saveable: true, questionType: 'free_text', reason: null };
    },

    /**
     * Which resume to attach, as a signed 5-minute link. Prefers a verified
     * tailored copy. Without a job (`jobId` omitted and the run is not linked
     * to one — a form found outside the user's listings) the main resume is
     * used, and the download is not recorded on an application: the panel
     * saves the job first (POST /ext/jobs/save) when the user wants that.
     */
    async resumeForJob(userId: string, body: Body<typeof ResumeForJobBodySchema>, apiOrigin: string): Promise<ResumeForJobResponse> {
      const run = await ownRun(userId, body.runId);
      const jobId = body.jobId ?? run.jobId;
      let job: ExtJobRow | null = null;
      if (jobId) {
        job = await deps.repo.loadJob(jobId);
        if (!visible(job, userId)) {
          if (body.jobId) throw new HttpError('not_found');
          job = null; // The run's job is no longer visible: treat the page as unknown.
        }
      }
      // A run belongs to one application: a different job would record the file on one and mark another applied.
      if (body.jobId && run.jobId && body.jobId !== run.jobId) {
        throw new HttpError('conflict', 'This form is linked to a different job.', { reason: EXTENSION_ERROR_CODES.runJobMismatch });
      }
      const { tailored, primary } = job ? await deps.repo.resumesFor(userId, job.id) : await deps.repo.resumesFor(userId, null);
      let chosen = primary;
      let isTailored = false;
      let tailoredNeedsReview = false;
      if (tailored) {
        if ((await deps.unverifiedClaims(tailored.id)) === 0) {
          chosen = tailored;
          isTailored = true;
        } else {
          tailoredNeedsReview = true;
        }
      }
      if (!chosen) throw new HttpError('not_found', 'Add a resume first.', { reason: EXTENSION_ERROR_CODES.noResume });
      const token = signFileToken({ u: userId, b: brandId(), v: chosen.id, j: job?.id ?? '', r: run.id }, { now: deps.now().getTime(), env: deps.env });
      if (!token) throw new HttpError('provider_not_configured', 'File links are not configured on this server.');
      const { buildExportFileName } = await import('../../roboapply/v2/lib/resumeExport.js');
      return {
        variantId: chosen.id,
        isTailored,
        fileName: `${buildExportFileName(null, { fallback: chosen.name })}.pdf`,
        downloadUrl: `${apiOrigin.replace(/\/$/, '')}/api/v1/roboapply/ext/files/${token}`,
        tailoredNeedsReview,
      };
    },

    /** The file behind a signed link; records the exact bytes on the application (RAApplicationArtifact). */
    async file(userId: string, signedToken: string): Promise<ExportedFile> {
      const check = verifyFileToken(signedToken, { now: deps.now().getTime(), env: deps.env });
      if (!check.ok) {
        throw new HttpError('not_found', check.reason === 'expired' ? 'This link has expired. Ask the extension for the file again.' : undefined, {
          reason: check.reason === 'expired' ? EXTENSION_ERROR_CODES.fileLinkExpired : undefined,
        });
      }
      const c = check.claims;
      if (c.u !== userId || c.b !== brandId()) throw new HttpError('not_found');
      const run = await ownRun(userId, c.r);
      // A link signed without a job (unknown page): the run may have been linked since (the user saved the job).
      const jobId = c.j || run.jobId;
      const job = jobId ? await deps.repo.loadJob(jobId) : null;
      if (c.j && !visible(job, userId)) throw new HttpError('not_found');
      const linked = visible(job, userId) ? job : null;
      const entryId = linked ? ((await deps.repo.trackerEntryFor(userId, linked.id)) ?? (await deps.tracker.saveForJob(userId, linked.id))) : null;
      let file: ExportedFile;
      try {
        file = await deps.exportResume(userId, c.v, { trackerEntryId: entryId, brand: deps.brand() });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code === 'unverified_claims') throw new HttpError('conflict', 'This resume has details to verify first.', { reason: 'unverified_claims' });
        if (code === 'resume_not_found' || (err as Error)?.name === 'ResumeNotFoundError') throw new HttpError('not_found');
        throw err;
      }
      if (file.artifactId) await soft('link artifact to run', deps.repo.linkArtifactToRun(file.artifactId, run.id));
      if (linked && entryId && (!run.trackerEntryId || run.jobId !== linked.id)) {
        await soft('link run to tracker', deps.repo.updateRun(run.id, { trackerEntryId: entryId, jobId: run.jobId ?? linked.id }));
      }
      return file;
    },

    async siteRequest(userId: string, body: Body<typeof SiteRequestBodySchema>): Promise<void> {
      const url = pageUrlWithoutQuery(body.url);
      if (!url) throw new HttpError('invalid_request', 'Use a web address.');
      // The host comes from the URL itself, never from the client's claim.
      const host = new URL(url).hostname.toLowerCase();
      await deps.repo.createSiteRequest({ userId, host, url, note: body.note?.trim() || null });
    },

    async uninstallSurvey(body: Body<typeof UninstallSurveyBodySchema>): Promise<void> {
      const note = body.note?.trim();
      await deps.repo.createUninstallSurvey({ brand: brandId(), userId: null, answers: { reasons: [...new Set(body.reasons)], ...(note ? { note } : {}) } });
    },
  };
}

export type ExtensionService = ReturnType<typeof createExtensionService>;
