// backend/src/roboapply/v2/services/RAQueueService.ts
//
// Review-queue service. Shapes the V1 auto-apply engine's pending runs
// (RoboApplyRun in status queued/previewing) into the V3 `RAQueueItem`
// contract (lib/api/v2/types.ts) and implements the three queue mutations:
//
//   send       — submit-now: flip the run to `submitted` (sets actualSubmitAt)
//   skip       — cancel: flip the run to `skipped_by_user`
//   updateCover — overwrite the draft cover letter on the run
//
// All reads/writes go through `v1Bridge` (the only V2 file that touches V1
// tables) so the import boundary stays clean.
//
// Response-shape parity with the stub (lib/stub/raV2.stub.ts §Queue):
//   - `list()`  → { items: RAQueueItem[], pendingCount }   (only `pending`)
//   - `send()`  → { item } with status 'sent'
//   - `skip()`  → { item } with status 'skipped'
//   - updateCover → { item } with the new cover, ≤6000 chars (else 422)
//
// Status mapping V1 → V3 `RAQueueItemStatus`:
//   queued | previewing            → 'pending'   (still in the review window)
//   submitted                      → 'sent'
//   skipped_by_user | failed       → 'skipped'   (no longer actionable)
//   undone                         → 'skipped'

import {
  getRunForUser,
  listQueueRunsForUser,
  resolveCoverLetterForRun,
  updateRunForUser,
  type V1RunRow,
} from '../lib/v1Bridge.js';
import { RA_DEFAULT_LOCALE, type RaLocale } from '../lib/raLocale.js';
import {
  coverLengthFor,
  format,
  getQueueMessages,
} from '../lib/raQueueMessages.js';
import { logger } from '../../../services/LoggerService.js';

export type RAQueueItemStatus = 'pending' | 'sending' | 'sent' | 'skipped';

export interface RAQueueCheck {
  key: string;
  value: string;
}

export interface RAQueueItem {
  id: string;
  jobId: string | null;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  location: string | null;
  matchScore: number;
  plannedSubmitAt: string;
  status: RAQueueItemStatus;
  coverLetterMarkdown: string;
  checks: RAQueueCheck[];
  createdAt: string;
  updatedAt: string;
}

export interface QueueListResult {
  items: RAQueueItem[];
  pendingCount: number;
}

export interface QueueItemResult {
  item: RAQueueItem;
}

export const MAX_COVER_LETTER_LEN = 6000;

export class QueueItemNotFoundError extends Error {
  constructor() {
    super('Queue item not found');
    this.name = 'QueueItemNotFoundError';
  }
}

/** `message` is a MACHINE CODE (snake_case), not prose — the route ships it
 *  verbatim in the 422 `error` field and the frontend maps codes to localized
 *  copy (see the i18n rule in routes/queue.ts). */
export class QueueInvalidInputError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'QueueInvalidInputError';
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function iso(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function mapStatus(v1Status: string): RAQueueItemStatus {
  switch (v1Status) {
    case 'queued':
    case 'previewing':
      return 'pending';
    case 'submitted':
      return 'sent';
    case 'skipped_by_user':
    case 'failed':
    case 'undone':
      return 'skipped';
    default:
      return 'pending';
  }
}

/** Pull a few signals out of the V1 `matchExplanation` (full MatchResult JSON)
 *  so the queue card's check chips carry real, per-run context. */
interface MatchExplanationLike {
  overallFit?: {
    summary?: string;
    topReasons?: string[];
  };
  skillsMatch?: { matchedSkills?: unknown[] };
  customAnswers?: Array<{ question: string; answer: string }>;
}

/** Derive the 4 "checks" chips. The V1 RoboApplyRun model has NO equivalent of
 *  the V3 prototype's per-application checklist (Resume / Cover / Questions /
 *  Portfolio), so we DERIVE sensible values from what V1 does store:
 *    - Resume   ← the run always carries a tailored resume snapshot + adapter,
 *                 and the matcher's top reason gives the "why tailored" line.
 *    - Cover    ← presence + length of the (resolved) cover letter.
 *    - Questions← count of customAnswers in the cover-letter cache output, if
 *                 any (Greenhouse screening answers); else "—".
 *    - Portfolio← V1 has no portfolio-attachment concept → static "Not tracked".
 *  Each gap is noted in the value text so it's honest, not invented.
 *  (Contract gap: V1 lacks `checks`; derived here. See report.)
 *
 *  All copy comes from the raQueueMessages catalog in the request locale —
 *  these strings ship pre-rendered to the client, so the frontend bundles
 *  can't translate them. `topReason` is LLM output and arrives in whatever
 *  language the match ran in (locale is threaded into the matcher
 *  separately). */
function deriveChecks(
  run: V1RunRow,
  coverLetter: string,
  customAnswerCount: number,
  locale: RaLocale,
): RAQueueCheck[] {
  const m = getQueueMessages(locale);
  const expl = (run.matchExplanation ?? {}) as MatchExplanationLike;
  const topReason =
    expl.overallFit?.topReasons?.[0] ??
    (run.rationaleForPick && run.rationaleForPick.length > 0
      ? run.rationaleForPick
      : null);

  // Greenhouse / Lever are proper nouns — only the generic label localizes.
  // zh/zh-TW copy conventionally pads Latin tokens with spaces (…可透過 Lever
  // 投遞); the localized fallback label is CJK text and must NOT be padded.
  const properNounBoard =
    run.boardAdapter === 'greenhouse'
      ? 'Greenhouse'
      : run.boardAdapter === 'lever'
        ? 'Lever'
        : null;
  const padLatin = locale === 'zh' || locale === 'zh-TW';
  const boardLabel = properNounBoard
    ? padLatin
      ? ` ${properNounBoard} `
      : properNounBoard
    : m.directLink;

  const resumeValue = topReason
    ? format(m.tailoredWithReason, { reason: topReason.slice(0, 80) })
    : format(m.tailoredReadyFor, { board: boardLabel });

  const coverLength = coverLengthFor(locale, coverLetter);
  const coverValue =
    coverLength > 0
      ? format(m.coverDraft, { count: coverLength })
      : m.coverNotGenerated;

  const questionsValue =
    customAnswerCount > 0
      ? format(
          customAnswerCount === 1
            ? m.screeningAnswersOne
            : m.screeningAnswersMany,
          { count: customAnswerCount },
        )
      : m.noScreeningQuestions;

  return [
    { key: m.checkResume, value: resumeValue },
    { key: m.checkCover, value: coverValue },
    { key: m.checkQuestions, value: questionsValue },
    // V1 has no portfolio attachment surface — honest static value.
    { key: m.checkPortfolio, value: m.portfolioNotTracked },
  ];
}

function customAnswerCountFromExplanation(run: V1RunRow): number {
  const expl = (run.matchExplanation ?? {}) as MatchExplanationLike;
  return Array.isArray(expl.customAnswers) ? expl.customAnswers.length : 0;
}

async function toQueueItem(
  run: V1RunRow,
  locale: RaLocale = RA_DEFAULT_LOCALE,
): Promise<RAQueueItem> {
  const m = getQueueMessages(locale);
  const coverLetter = await resolveCoverLetterForRun(run);
  const customAnswerCount = customAnswerCountFromExplanation(run);
  const title = run.job?.title ?? m.untitledRole;
  const companyName = run.job?.companyName ?? m.unknownCompany;
  return {
    id: run.id,
    jobId: run.jobId,
    title,
    companyName,
    // V1 Job has no logo column.
    companyLogoUrl: null,
    location: run.job?.location ?? null,
    matchScore: run.matchScore,
    plannedSubmitAt: iso(run.plannedSubmitAt),
    status: mapStatus(run.status),
    coverLetterMarkdown: coverLetter,
    checks: deriveChecks(run, coverLetter, customAnswerCount, locale),
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
  };
}

export class RAQueueService {
  // Every public method takes the request locale (resolved by the route via
  // getRequestLocale) so all server-derived user-visible strings come back in
  // the language the user is reading the UI in. New methods on this service
  // MUST follow the same pattern.

  /** Pending review queue (V1 runs in queued/previewing), soonest-first. */
  async list(
    userId: string,
    locale: RaLocale = RA_DEFAULT_LOCALE,
  ): Promise<QueueListResult> {
    const runs = await listQueueRunsForUser(userId);
    const items = await Promise.all(runs.map((r) => toQueueItem(r, locale)));
    // Only `pending` items are returned by the stub's list(); our queue read
    // already filters to queued/previewing, which all map to 'pending'.
    const pending = items.filter((i) => i.status === 'pending');
    return { items: pending, pendingCount: pending.length };
  }

  /** Submit-now. Idempotent: a run already submitted stays submitted ('sent').
   *  Skipped/failed runs cannot be re-sent (404-equivalent invalid state is
   *  surfaced as the current shape — we simply return the row as-is). */
  async send(
    userId: string,
    runId: string,
    locale: RaLocale = RA_DEFAULT_LOCALE,
  ): Promise<QueueItemResult> {
    const existing = await getRunForUser(userId, runId);
    if (!existing) throw new QueueItemNotFoundError();

    // Already terminal → return current shape (idempotent, mirrors stub which
    // just re-flips to 'sent' but never errors on a missing row).
    if (existing.status === 'submitted') {
      return { item: await toQueueItem(existing, locale) };
    }

    const now = new Date();
    const updated = await updateRunForUser(userId, runId, {
      status: 'submitted',
      actualSubmitAt: now,
      updatedAt: now,
    });
    if (!updated) throw new QueueItemNotFoundError();
    logger.info('RA_V2_QUEUE', 'queue item submitted (send-now)', {
      userId,
      runId,
    });
    return { item: await toQueueItem(updated, locale) };
  }

  /** Skip / cancel a queued run. Maps to V1 `skipped_by_user`. */
  async skip(
    userId: string,
    runId: string,
    locale: RaLocale = RA_DEFAULT_LOCALE,
  ): Promise<QueueItemResult> {
    const existing = await getRunForUser(userId, runId);
    if (!existing) throw new QueueItemNotFoundError();

    if (existing.status === 'skipped_by_user') {
      return { item: await toQueueItem(existing, locale) };
    }

    const now = new Date();
    const updated = await updateRunForUser(userId, runId, {
      status: 'skipped_by_user',
      updatedAt: now,
    });
    if (!updated) throw new QueueItemNotFoundError();
    logger.info('RA_V2_QUEUE', 'queue item skipped', { userId, runId });
    return { item: await toQueueItem(updated, locale) };
  }

  /** Overwrite the draft cover letter on the run. ≤6000 chars (stub parity). */
  async updateCover(
    userId: string,
    runId: string,
    coverLetterMarkdown: string,
    locale: RaLocale = RA_DEFAULT_LOCALE,
  ): Promise<QueueItemResult> {
    if (typeof coverLetterMarkdown !== 'string') {
      throw new QueueInvalidInputError('cover_letter_required');
    }
    if (coverLetterMarkdown.length > MAX_COVER_LETTER_LEN) {
      throw new QueueInvalidInputError('cover_letter_too_long');
    }
    const existing = await getRunForUser(userId, runId);
    if (!existing) throw new QueueItemNotFoundError();

    const now = new Date();
    const updated = await updateRunForUser(userId, runId, {
      coverLetter: coverLetterMarkdown,
      updatedAt: now,
    });
    if (!updated) throw new QueueItemNotFoundError();
    logger.info('RA_V2_QUEUE', 'queue item cover updated', {
      userId,
      runId,
      length: coverLetterMarkdown.length,
    });
    return { item: await toQueueItem(updated, locale) };
  }
}

export const raQueueService = new RAQueueService();
export const _internal_toQueueItem = toQueueItem;
