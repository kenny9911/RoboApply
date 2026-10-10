// server/src/features/interview/retention.ts — practice interview retention (WP-63a).
//
// Both privacy notices publish one rule (PRODUCT F-TRUST-06, CN_TW L-11,
// compliance/retention.ts row `interview_recordings`): practice recordings and
// transcripts are kept for INTERVIEW_RETENTION_DAYS (CN_ on GoApply; default
// and maximum 90 days), then deleted — on BOTH brands.
//
// What is deleted, for sessions created before the window:
//   live practice (InterviewSession) — the recording object, the transcript
//     objects (transcript.json / transcript.txt) and the report sidecar
//     (report.json, which repeats the report's quotes) in the brand's own
//     bucket; the transcript rows (`transcript`, `transcriptText`) plus every
//     column that points at a deleted object (recording*, transcriptKey,
//     egressId);
//   written practice (RAMockSession) — the transcript (`transcript`).
// The candidate's words are also taken out of what is kept. The report is
// written from the transcript and quotes it by design (a per-question
// `keyQuote`, the "before" side of each rewrite example, quoted evidence in
// strengths, gaps and notes), so on both kinds of session:
//   - `keyQuote` is removed;
//   - a rewrite example keeps only its "after" (model) side;
//   - every quoted span (“…”, "…", 「…」, 『…』, «…», ‘…’) in the report prose,
//     strengths, gaps, summary and score notes becomes an empty quote (“…”).
// What stays: the session row, its scores and the rest of the AI-written
// report (the user's practice history, the job's "Practiced" step and credit
// metering read them). Words of the candidate that the report repeats WITHOUT
// quotation marks cannot be told apart from the AI's own prose; the report
// prompts ask for quotation marks, and this is listed as a known limit.
//
// Objects are deleted first. A row keeps its object keys when the bucket is
// not configured or a delete fails, so the next run retries the object; the
// transcript text and the quotes in the database are cleared regardless.
//
// The task runs once per brand (compliance-daily, inside runWithBrand), scoped
// to that brand's users (`User.brand`), so each brand's objects are deleted
// from its own bucket (S3_* / CN_S3_*). It pages by id and stops on the budget;
// written practice (DB-only) is purged before live sessions (objects).

import prisma from '../../lib/prisma.js';
import { getInterviewRetentionDays } from '../../interview-engine/config.js';
import { interviewR2Storage } from '../../interview-engine/storage/r2Storage.js';
import { inBrand } from '../../interview-engine/providers/index.js';
import type { Budget } from '../../platform/queue/index.js';
import type { BrandId } from '../../platform/brand/registry.js';

export const RETENTION_BATCH_SIZE = 50;
/** Stop starting a batch when this little budget is left. */
const BATCH_RESERVE_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Quote redaction (pure) ─────────────────────────────────────────────────

/** Quoted spans in the scripts the report languages use. Single straight
 *  quotes are left alone (apostrophes). */
const QUOTED_SPAN =
  /"[^"\n]{1,800}"|“[^”\n]{1,800}”|„[^“”\n]{1,800}[“”]|「[^」]{1,800}」|『[^』]{1,800}』|«[^»]{1,800}»|‹[^›\n]{1,800}›|‘[^’\n]{1,800}’/g;

/** Replace every quoted span with an empty quote of the same marks. */
export function redactQuotes(text: string): string {
  return text.replace(QUOTED_SPAN, (m) => `${m[0]}…${m[m.length - 1]}`);
}

const ARROW = /\s*(?:→|⟶|➔|->|=>)\s*/;

/**
 * A recommendation example is "before → after"; the before side reuses the
 * candidate's own words. Keep the after side only. Without an arrow, a
 * two-line example drops its first line (the before side); anything else
 * keeps its text with the quotes emptied.
 */
export function afterSideOnly(example: string): string {
  const parts = example.split(ARROW);
  if (parts.length > 1) return redactQuotes(parts[parts.length - 1]!.trim());
  const lines = example.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return redactQuotes(lines.slice(1).join('\n'));
  return redactQuotes(example);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const redactStr = (v: unknown): unknown => (typeof v === 'string' ? redactQuotes(v) : v);
const redactStrList = (v: unknown): unknown => (Array.isArray(v) ? v.map(redactStr) : v);

/** Score breakdown rows ({ key, value, note }): empty the quotes in each note. */
export function redactBreakdown(breakdown: unknown): unknown {
  if (!Array.isArray(breakdown)) return breakdown;
  return breakdown.map((b) => (isObj(b) && typeof b.note === 'string' ? { ...b, note: redactQuotes(b.note) } : b));
}

function redactScoreFields(o: Obj): Obj {
  const out: Obj = { ...o };
  if ('summary' in out) out.summary = redactStr(out.summary);
  if ('strengths' in out) out.strengths = redactStrList(out.strengths);
  if ('gaps' in out) out.gaps = redactStrList(out.gaps);
  if ('breakdown' in out) out.breakdown = redactBreakdown(out.breakdown);
  return out;
}

/**
 * The stored report (`InterviewSession.report`, rich v2 or deterministic)
 * without the candidate's quoted words. Unknown shapes pass through.
 */
export function redactReportQuotes(report: unknown): unknown {
  if (!isObj(report)) return report;
  const out = redactScoreFields(report);
  if (isObj(out.score)) out.score = redactScoreFields(out.score);
  if (Array.isArray(out.recommendations)) {
    out.recommendations = out.recommendations.map((r) => {
      if (!isObj(r)) return r;
      return {
        ...r,
        ...(typeof r.detail === 'string' ? { detail: redactQuotes(r.detail) } : {}),
        ...(typeof r.example === 'string' ? { example: afterSideOnly(r.example) } : {}),
      };
    });
  }
  if (Array.isArray(out.questionAnalysis)) {
    out.questionAnalysis = out.questionAnalysis.map((q) => {
      if (!isObj(q)) return q;
      const { keyQuote: _dropped, ...rest } = q;
      void _dropped;
      for (const k of ['answerSummary', 'analysis', 'correction'] as const) {
        if (typeof rest[k] === 'string') rest[k] = redactQuotes(rest[k] as string);
      }
      return rest;
    });
  }
  return out;
}

/** The kept score columns of a session, quotes emptied. */
export interface RedactedScore {
  strengths: string[];
  gaps: string[];
  breakdown: unknown;
}

function redactScoreColumns(row: { strengths?: string[] | null; gaps?: string[] | null; breakdown?: unknown }): RedactedScore {
  return {
    strengths: (row.strengths ?? []).map(redactQuotes),
    gaps: (row.gaps ?? []).map(redactQuotes),
    breakdown: redactBreakdown(row.breakdown ?? null),
  };
}

// ─── Data access ──────────────────────────────────────────────────────────────

export interface RetentionSessionRow {
  id: string;
  recordingKey: string | null;
  transcriptKey: string | null;
  egressId: string | null;
  report?: unknown;
  strengths?: string[];
  gaps?: string[];
  summary?: string | null;
  breakdown?: unknown;
}

export interface WrittenRetentionRow {
  id: string;
  strengths?: string[];
  gaps?: string[];
  note?: string | null;
  breakdown?: unknown;
}

/** What is written back to a purged live session (beyond the cleared transcript). */
export interface LiveSessionRedaction extends RedactedScore {
  report: unknown;
  summary: string | null;
}

/** What is written back to a purged written practice. */
export interface WrittenSessionRedaction extends RedactedScore {
  note: string | null;
}

export interface RetentionStorage {
  isConfigured(): boolean;
  /** True when the object is gone (a missing object counts as deleted). */
  deleteObject(key: string): Promise<boolean>;
  recordingKey(sessionId: string, ext?: string): string;
  transcriptJsonKey(sessionId: string): string;
  transcriptTextKey(sessionId: string): string;
  reportKey(sessionId: string): string;
}

export interface RetentionDeps {
  /** Sessions of `brand` created before `cutoff` that still hold a recording or transcript, id > `afterId`. */
  findLiveSessions(brand: BrandId, cutoff: Date, afterId: string | null, take: number): Promise<RetentionSessionRow[]>;
  /** Clear the transcript columns and write the quote-free report; with
   *  `objectsGone`, also clear every pointer to a deleted object. */
  clearLiveSession(id: string, objectsGone: boolean, redacted: LiveSessionRedaction): Promise<void>;
  /** Written practices of `brand` created before `cutoff` that still hold a transcript, id > `afterId`. */
  findWrittenSessions(brand: BrandId, cutoff: Date, afterId: string | null, take: number): Promise<WrittenRetentionRow[]>;
  /** Clear a written practice's transcript and write its quote-free score. */
  clearWrittenSession(id: string, redacted: WrittenSessionRedaction): Promise<void>;
  storage: RetentionStorage;
}

const EMPTY_TRANSCRIPT: never[] = [];
const OBJECT_POINTERS_CLEARED = {
  transcriptKey: null,
  recordingKey: null,
  recordingMimeType: null,
  recordingBytes: null,
  recordingDurationSec: null,
  egressId: null,
} as const;

export const defaultRetentionDeps: RetentionDeps = {
  async findLiveSessions(brand, cutoff, afterId, take) {
    return prisma.interviewSession.findMany({
      where: {
        user: { brand },
        createdAt: { lt: cutoff },
        ...(afterId ? { id: { gt: afterId } } : {}),
        OR: [
          { recordingKey: { not: null } },
          { transcriptKey: { not: null } },
          { transcriptText: { not: null } },
          { egressId: { not: null } },
          { NOT: { transcript: { equals: EMPTY_TRANSCRIPT } } },
        ],
      },
      select: {
        id: true,
        recordingKey: true,
        transcriptKey: true,
        egressId: true,
        report: true,
        strengths: true,
        gaps: true,
        summary: true,
        breakdown: true,
      },
      orderBy: { id: 'asc' },
      take,
    });
  },
  async clearLiveSession(id, objectsGone, redacted) {
    await prisma.interviewSession.update({
      where: { id },
      data: {
        transcript: EMPTY_TRANSCRIPT,
        transcriptText: null,
        strengths: redacted.strengths,
        gaps: redacted.gaps,
        summary: redacted.summary,
        ...(redacted.breakdown != null ? { breakdown: redacted.breakdown as object } : {}),
        ...(redacted.report != null ? { report: redacted.report as object } : {}),
        ...(objectsGone ? OBJECT_POINTERS_CLEARED : {}),
      },
    });
  },
  async findWrittenSessions(brand, cutoff, afterId, take) {
    return prisma.rAMockSession.findMany({
      where: {
        user: { brand },
        createdAt: { lt: cutoff },
        ...(afterId ? { id: { gt: afterId } } : {}),
        NOT: { transcript: { equals: EMPTY_TRANSCRIPT } },
      },
      select: { id: true, strengths: true, gaps: true, note: true, breakdown: true },
      orderBy: { id: 'asc' },
      take,
    });
  },
  async clearWrittenSession(id, redacted) {
    await prisma.rAMockSession.update({
      where: { id },
      data: {
        transcript: EMPTY_TRANSCRIPT,
        strengths: redacted.strengths,
        gaps: redacted.gaps,
        note: redacted.note,
        ...(redacted.breakdown != null ? { breakdown: redacted.breakdown as object } : {}),
      },
    });
  },
  storage: interviewR2Storage,
};

/** The object keys a session may own: recording (stored key, or the default
 *  one once egress was started), both transcript files, and the report
 *  sidecar once a transcript or report exists. */
export function sessionObjectKeys(row: RetentionSessionRow, storage: RetentionStorage): string[] {
  const keys = new Set<string>();
  if (row.recordingKey) keys.add(row.recordingKey);
  else if (row.egressId) keys.add(storage.recordingKey(row.id, 'mp4'));
  if (row.transcriptKey) {
    keys.add(row.transcriptKey);
    keys.add(storage.transcriptJsonKey(row.id));
    keys.add(storage.transcriptTextKey(row.id));
  }
  if (row.transcriptKey || row.report != null) keys.add(storage.reportKey(row.id));
  return [...keys];
}

export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export interface RetentionResult {
  processed: number;
  sessions: number;
  objectsDeleted: number;
  /** Rows whose objects could not be deleted (kept for the next run). */
  objectsPending: number;
  writtenTranscripts: number;
  retentionDays: number;
  cutoff: string;
  stoppedBy: 'idle' | 'budget';
}

/** Purge one brand's practice recordings and transcripts older than its window. */
export async function purgeInterviewArtifacts(
  input: { brand: BrandId; now: Date; budget?: Budget },
  deps: RetentionDeps = defaultRetentionDeps,
): Promise<RetentionResult> {
  return inBrand(input.brand, async () => {
    const retentionDays = getInterviewRetentionDays(input.brand);
    const cutoff = retentionCutoff(input.now, retentionDays);
    const storageReady = deps.storage.isConfigured();
    const outOfBudget = () => input.budget?.exhausted(BATCH_RESERVE_MS) === true;
    let sessions = 0;
    let objectsDeleted = 0;
    let objectsPending = 0;
    let writtenTranscripts = 0;
    let stoppedBy: RetentionResult['stoppedBy'] = 'idle';

    // Written practice first: it is DB-only and cheap, so a backlog of live
    // sessions whose objects keep failing to delete (retried every run) can
    // never use up the budget before written transcripts are purged.
    let afterId: string | null = null;
    for (;;) {
      if (outOfBudget()) {
        stoppedBy = 'budget';
        break;
      }
      const rows = await deps.findWrittenSessions(input.brand, cutoff, afterId, RETENTION_BATCH_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        await deps.clearWrittenSession(row.id, {
          ...redactScoreColumns(row),
          note: typeof row.note === 'string' ? redactQuotes(row.note) : null,
        });
        writtenTranscripts += 1;
      }
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }

    afterId = null;
    while (stoppedBy === 'idle') {
      if (outOfBudget()) {
        stoppedBy = 'budget';
        break;
      }
      const rows = await deps.findLiveSessions(input.brand, cutoff, afterId, RETENTION_BATCH_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        const keys = sessionObjectKeys(row, deps.storage);
        let gone = keys.length === 0;
        if (keys.length > 0 && storageReady) {
          const results = await Promise.all(keys.map((k) => deps.storage.deleteObject(k)));
          objectsDeleted += results.filter(Boolean).length;
          gone = results.every(Boolean);
        }
        if (!gone) objectsPending += 1;
        await deps.clearLiveSession(row.id, gone, {
          ...redactScoreColumns(row),
          report: redactReportQuotes(row.report ?? null),
          summary: typeof row.summary === 'string' ? redactQuotes(row.summary) : null,
        });
        sessions += 1;
      }
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < RETENTION_BATCH_SIZE) break;
    }

    return {
      processed: sessions + writtenTranscripts,
      sessions,
      objectsDeleted,
      objectsPending,
      writtenTranscripts,
      retentionDays,
      cutoff: cutoff.toISOString(),
      stoppedBy,
    };
  });
}
