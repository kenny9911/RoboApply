// server/src/platform/llm/contentSafety/events.ts
//
// RAContentSafetyEvent rows (WP-24). One row per check: brand, task (as
// `surface`), direction, verdict, provider, and in `matched` the reason,
// labels and rule ids.
//
// Excerpt policy — the only user text ever stored:
//   - every row: SHA-256 of the checked text and its length;
//   - `block` and `review` rows also: an excerpt of at most 200 characters,
//     centred on the first hit when the provider reports one. `excerptAnchor`
//     says what the excerpt is placed on: 'hit' (the hit itself),
//     'slice_start' (the provider only named the 2,000-character slice it
//     flagged; the excerpt is that slice's first 200 characters and may not
//     contain the flagged content; `slice` gives its index and length) or
//     'text_start' (no location known);
//   - `pass` and `error` rows: no excerpt.
// Rows keep `userId` as a plain string and are purged after 6 months by
// compliance-daily (ra-compliance.prisma).
//
// Writes never change a verdict: a failed write is logged and swallowed.
// `block`, `review` and `error` rows are awaited (they are rare and are the
// record that matters); `pass` rows are written in the background.

import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import { codePointLength } from './normalize.js';
import type {
  ContentSafetyContext,
  ContentSafetyEventVerdict,
  ContentSafetyFailureCause,
  ContentSafetyResult,
  ContentSafetyStage,
} from './types.js';

export const EXCERPT_MAX_CHARS = 200;
/** Characters kept before the hit when the excerpt is centred on it. */
const EXCERPT_LEAD_CHARS = 60;
const SURFACE_MAX = 64;

export interface ContentSafetyEventMatched {
  reason: string;
  labels: string[];
  ruleIds?: string[];
  listVersion?: string;
  textSha256: string;
  /** Length of the checked text in characters (code points). */
  textLength: number;
  /** ≤ 200 characters; only on `block` and `review`. */
  excerpt?: string;
  /** What the excerpt is placed on (block/review rows only). */
  excerptAnchor?: 'hit' | 'slice_start' | 'text_start';
  /** The flagged slice when excerptAnchor is 'slice_start'. */
  slice?: { index: number; length: number };
  /** Streamed output: the verdict came from the whole-text keyword scan in finish(). */
  finalScan?: true;
  callId?: string;
  /** Streamed output: number of segments checked. */
  segments?: number;
}

export interface ContentSafetyEventRow {
  brand: string;
  userId: string | null;
  surface: string;
  direction: ContentSafetyStage;
  verdict: ContentSafetyEventVerdict;
  provider: string | null;
  matched: ContentSafetyEventMatched;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * At most EXCERPT_MAX_CHARS code points starting `lead` code points before
 * `hitOffset` (UTF-16) when given. Control characters become spaces.
 */
export function excerptOf(text: string, hitOffset?: number, lead: number = EXCERPT_LEAD_CHARS): string {
  const cps = Array.from(text);
  let start = 0;
  if (hitOffset !== undefined && hitOffset > 0) {
    // Convert the UTF-16 offset to a code-point index.
    let units = 0;
    let idx = 0;
    while (idx < cps.length && units < hitOffset) {
      units += cps[idx].length;
      idx++;
    }
    start = Math.max(0, Math.min(idx - lead, cps.length - EXCERPT_MAX_CHARS));
  }
  // eslint-disable-next-line no-control-regex
  return cps.slice(start, start + EXCERPT_MAX_CHARS).join('').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export interface BuildEventInput {
  stage: ContentSafetyStage;
  text: string;
  ctx: ContentSafetyContext;
  verdict: ContentSafetyEventVerdict;
  result?: ContentSafetyResult;
  /** For `error` rows. */
  cause?: ContentSafetyFailureCause;
  provider?: string | null;
  segments?: number;
  finalScan?: boolean;
}

export function buildContentSafetyEvent(input: BuildEventInput): ContentSafetyEventRow {
  const { stage, text, ctx, verdict, result } = input;
  const matched: ContentSafetyEventMatched = {
    reason: verdict === 'error' ? (input.cause ?? 'provider_error') : (result?.reason ?? (verdict === 'pass' ? 'clean' : 'provider_label')),
    labels: result?.labels ?? [],
    textSha256: sha256Hex(text),
    textLength: codePointLength(text),
  };
  if (result?.ruleIds?.length) matched.ruleIds = result.ruleIds;
  if (result?.listVersion) matched.listVersion = result.listVersion;
  if (verdict === 'block' || verdict === 'review') {
    const slice = result?.hitSlice;
    if (slice && result?.hitOffset !== undefined) {
      matched.excerpt = excerptOf(text, result.hitOffset, 0);
      matched.excerptAnchor = 'slice_start';
      matched.slice = { index: slice.index, length: slice.length };
    } else {
      matched.excerpt = excerptOf(text, result?.hitOffset);
      matched.excerptAnchor = result?.hitOffset !== undefined ? 'hit' : 'text_start';
    }
  }
  if (ctx.callId) matched.callId = ctx.callId;
  if (input.segments !== undefined) matched.segments = input.segments;
  if (input.finalScan) matched.finalScan = true;
  return {
    brand: ctx.brand,
    userId: ctx.userId ?? null,
    surface: (ctx.task || 'unknown').slice(0, SURFACE_MAX),
    direction: stage,
    verdict,
    provider: input.provider ?? result?.provider ?? null,
    matched,
  };
}

export type ContentSafetyEventWriter = (row: ContentSafetyEventRow) => Promise<void>;

const prismaWriter: ContentSafetyEventWriter = async (row) => {
  const { default: prisma } = await import('../../../lib/prisma.js');
  await prisma.rAContentSafetyEvent.create({
    data: {
      brand: row.brand,
      userId: row.userId,
      surface: row.surface,
      direction: row.direction,
      verdict: row.verdict,
      provider: row.provider,
      matched: JSON.parse(JSON.stringify(row.matched)) as Prisma.InputJsonValue,
    },
  });
};

/**
 * Under Vitest the default writer is a no-op so unrelated suites that reach a
 * GoApply LLM path never write to a database; tests that care install their
 * own writer with setContentSafetyEventWriter.
 */
const defaultWriter: ContentSafetyEventWriter = async (row) => {
  if (process.env.VITEST) return;
  await prismaWriter(row);
};

let writer: ContentSafetyEventWriter = defaultWriter;

/** Test / wiring seam: replace the event writer (null restores the Prisma writer). */
export function setContentSafetyEventWriter(next: ContentSafetyEventWriter | null): void {
  writer = next ?? defaultWriter;
}

/** Write one row; never throws. Awaited for non-pass verdicts, background for `pass`. */
export async function recordContentSafetyEvent(row: ContentSafetyEventRow): Promise<void> {
  const write = (async () => {
    try {
      await writer(row);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[contentSafety] event write failed:', (err as Error)?.message ?? err);
    }
  })();
  if (row.verdict !== 'pass') await write;
}
