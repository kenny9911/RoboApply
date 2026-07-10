// backend/src/interview-engine/sessions/lifecycleHelpers.ts
//
// Pure, DB-free helpers for the session lifecycle: transcript ordering,
// participation-based duration, and liveMetrics telemetry sanitation/capping.
// Kept out of InterviewSessionService so they stay unit-testable without
// pulling in Prisma / LiveKit / config.

import type { TranscriptTurn, WorkerMetricEvent } from '../types.js';

// Telemetry caps. The stored arrays are diagnostic, not authoritative — the
// NEWEST events carry the signal (the failure usually happens at the end), so
// every cap keeps the tail.
export const MAX_CLIENT_EVENTS_PER_CALL = 50;
export const MAX_EVENT_TYPE_LEN = 64;
export const MAX_STORED_CLIENT_EVENTS = 500;
export const MAX_STORED_WORKER_METRIC_EVENTS = 2000;

// ─── Transcript ordering + duration ────────────────────────────────────────

/** Sort turns by ts, STABLY: equal or non-finite timestamps keep their arrival
 *  order (Array.prototype.sort is spec-stable since ES2019), so flush batches
 *  without usable timestamps degrade to append order instead of shuffling. */
export function sortTurnsByTs(turns: TranscriptTurn[]): TranscriptTurn[] {
  return [...turns].sort((a, b) => {
    const ta = typeof a.ts === 'number' && Number.isFinite(a.ts) ? a.ts : null;
    const tb = typeof b.ts === 'number' && Number.isFinite(b.ts) ? b.ts : null;
    if (ta === null || tb === null) return 0;
    return ta - tb;
  });
}

/**
 * Billable duration from PARTICIPATION, not wall-clock. A candidate who
 * connects and never speaks (LiveKit's emptyTimeout eventually tears the room
 * down) must bill 0 — not the 15+ minutes it took the room to give up.
 *
 *   - no candidate turns          → 0
 *   - otherwise                   → ts span first→last turn (ANY role: the
 *                                   interviewer's opening/closing bracket the
 *                                   conversation), minimum 1s
 *   - wallClockCeilingSec (startedAt→finalize) caps the result, so a
 *     clock-skewed worker timestamp can never inflate the bill.
 */
export function computeParticipationDurationSec(
  turns: TranscriptTurn[],
  wallClockCeilingSec: number | null,
): number {
  const hasCandidateTurn = turns.some((t) => t.role === 'candidate');
  if (!hasCandidateTurn) return 0;

  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const t of turns) {
    if (typeof t.ts === 'number' && Number.isFinite(t.ts)) {
      if (t.ts < first) first = t.ts;
      if (t.ts > last) last = t.ts;
    }
  }
  const spanSec = last > first ? Math.round((last - first) / 1000) : 0;
  const sec = Math.max(1, spanSec);
  return wallClockCeilingSec !== null && Number.isFinite(wallClockCeilingSec)
    ? Math.min(sec, Math.max(0, Math.round(wallClockCeilingSec)))
    : sec;
}

// ─── Recording artifact metadata ───────────────────────────────────────────

/** MIME type for the Egress recording. Voice mode records audioOnly, so the
 *  MP4 container holds no video track — 'audio/mp4', not 'video/mp4' (which
 *  would misdescribe the artifact in downloads and playback metadata). */
export function recordingMimeForMode(mode: string): 'audio/mp4' | 'video/mp4' {
  return mode === 'voice' ? 'audio/mp4' : 'video/mp4';
}

// ─── Expiry reconciliation (cron sweep) ────────────────────────────────────

export type ReconcileAction = 'finalize' | 'expire' | 'skip';

/** What the expiry sweep does with a stranded (past-expiresAt, quiet) session:
 *  ingested transcript turns exist → finalize, so the user still gets a report
 *  (and the cost ledger is written); no turns → 'expired' (nothing to score).
 *  Terminal states are never touched. */
export function decideReconcileAction(status: string, turnCount: number): ReconcileAction {
  if (status !== 'created' && status !== 'live' && status !== 'finalizing') return 'skip';
  return turnCount > 0 ? 'finalize' : 'expire';
}

// ─── liveMetrics blob ──────────────────────────────────────────────────────

/** Shape of InterviewSession.liveMetrics. All parts optional — the column is
 *  written incrementally by three independent senders (worker lifecycle,
 *  worker metrics batches, browser client-events). */
export interface LiveMetricsBlob {
  worker?: Record<string, unknown>;
  events?: unknown[];
  clientEvents?: unknown[];
  [key: string]: unknown;
}

/** Read the stored liveMetrics JSON defensively (null / non-object → {}). */
export function asLiveMetrics(value: unknown): LiveMetricsBlob {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as LiveMetricsBlob) }
    : {};
}

/** Append `incoming` to a possibly-missing stored array, keeping only the LAST
 *  `max` entries. Tolerates a corrupted (non-array) stored value by starting
 *  fresh — telemetry must never throw over its own history. */
export function capTail<T>(existing: unknown, incoming: T[], max: number): T[] {
  const base = Array.isArray(existing) ? (existing as T[]) : [];
  const merged = base.concat(incoming);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// ─── Event sanitation ──────────────────────────────────────────────────────

export interface ClientTelemetryEvent {
  type: string;
  ts: number;
  data?: Record<string, unknown>;
}

/** Validate browser client-events: ≤50 per call, type required (≤64 chars),
 *  ts coerced to a finite epoch-ms number, data kept only when it's a plain
 *  object. Anything else is silently dropped — bad telemetry is not an error. */
export function sanitizeClientEvents(raw: unknown): ClientTelemetryEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientTelemetryEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type.trim().slice(0, MAX_EVENT_TYPE_LEN) : '';
    if (!type) continue;
    const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : Date.now();
    const data = r.data && typeof r.data === 'object' && !Array.isArray(r.data)
      ? (r.data as Record<string, unknown>)
      : undefined;
    out.push({ type, ts, ...(data ? { data } : {}) });
    if (out.length >= MAX_CLIENT_EVENTS_PER_CALL) break;
  }
  return out;
}

/** Validate worker metric events: type required (≤64 chars), ts coerced, the
 *  rest of each event kept verbatim (the latency field names are the worker's
 *  contract). Per-call intake is capped at the storage cap — anything beyond
 *  it would be trimmed away immediately anyway. */
export function sanitizeMetricEvents(raw: unknown): WorkerMetricEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkerMetricEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type.trim().slice(0, MAX_EVENT_TYPE_LEN) : '';
    if (!type) continue;
    const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : Date.now();
    out.push({ ...r, type, ts } as WorkerMetricEvent);
    if (out.length >= MAX_STORED_WORKER_METRIC_EVENTS) break;
  }
  return out;
}

// ─── Aggregate summary for the per-batch log line ──────────────────────────

// Field names a worker latency event may carry its value under. Checked in
// order; first finite number wins. Kept permissive — the worker sender is a
// separate deploy and its exact field naming must not break our aggregation.
const LATENCY_FIELDS = ['ms', 'value', 'durationMs', 'latencyMs', 'delayMs', 'ttftMs', 'ttfbMs', 'eouDelayMs'] as const;

function metricLatencyMs(e: WorkerMetricEvent): number | null {
  for (const k of LATENCY_FIELDS) {
    const v = e[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** Per-batch aggregate for the single structured log line: per-type counts
 *  plus p50/max for the three canonical latency buckets (eou / llm-ttft /
 *  tts-ttfb) when present. Type matching is fuzzy (case/punctuation-blind)
 *  so 'eou_metrics', 'llm-ttft' and 'ttsTTFB' all land in the right bucket. */
export function summarizeMetricEvents(events: WorkerMetricEvent[]): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const buckets: Record<string, number[]> = {};
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    const norm = e.type.toLowerCase().replace(/[^a-z]/g, '');
    const bucket = norm.includes('eou')
      ? 'eou'
      : norm.includes('ttft') || norm.includes('llm')
        ? 'llm_ttft'
        : norm.includes('ttfb') || norm.includes('tts')
          ? 'tts_ttfb'
          : null;
    if (!bucket) continue;
    const v = metricLatencyMs(e);
    if (v !== null) (buckets[bucket] ??= []).push(v);
  }
  const latency: Record<string, { n: number; p50: number; max: number }> = {};
  for (const [bucket, vals] of Object.entries(buckets)) {
    latency[bucket] = { n: vals.length, p50: p50(vals), max: Math.max(...vals) };
  }
  return { counts, ...(Object.keys(latency).length > 0 ? { latency } : {}) };
}

function p50(vals: number[]): number {
  const sorted = [...vals].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
