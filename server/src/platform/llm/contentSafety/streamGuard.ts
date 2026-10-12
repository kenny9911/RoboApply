// server/src/platform/llm/contentSafety/streamGuard.ts
//
// Streamed GoApply output (WP-24): no delta reaches the user before it has
// been checked. The guard holds deltas back, checks them in segments of
// about 300 characters and releases a segment only after it passes.
//
// A keyword split across two segments is still found: each segment is
// prefixed with already-released text whose separator-free (compact) form is
// at least MAX_TERM_LENGTH characters long — matching ignores separators, so
// the overlap is measured the same way — and never starts in the middle of a
// Latin word. A non-final segment also holds back a trailing partial Latin
// word until the next segment, so a whole-word English term is never matched
// against half a word. As a last check, finish() runs the keyword list over
// the whole released text (cheap, no provider call) before releasing the
// final segment.
//
// On `block` the guard throws ContentBlockedError: the caller stops the
// stream and tells the user plainly that the rest of the reply was blocked
// (text already released was checked and stays as it is — nothing is
// rewritten). Provider errors and timeouts throw ContentSafetyUnavailableError
// (fail closed).
//
// One event row per stream (the summary: worst verdict, labels, segment
// count), not one per segment; every row hashes the whole reply produced so
// far. RoboApply streams pass straight through.
//
//   const guard = createOutputStreamGuard(ctx);
//   for await (const delta of llmStream) send(await guard.push(delta));
//   send(await guard.finish());

import { contentSafetyApplies, getContentSafetyProvider, runCheck } from './engine.js';
import { buildContentSafetyEvent, recordContentSafetyEvent } from './events.js';
import { MAX_TERM_LENGTH } from './keywordList.js';
import { codePointLength, compactUnits, nextCodePointEnd, prevCodePointStart } from './normalize.js';
import {
  ContentBlockedError,
  ContentSafetyUnavailableError,
  worstVerdict,
  type ContentSafetyContext,
  type ContentSafetyHitSlice,
  type ContentSafetyResult,
  type ContentSafetyVerdict,
} from './types.js';

export interface OutputStreamGuard {
  /** Add a delta; resolves to the text now cleared for release ('' while holding back). */
  push(delta: string): Promise<string>;
  /** Check what is still held back; resolves to it. Records the stream's event row. */
  finish(): Promise<string>;
}

export interface OutputStreamGuardOptions {
  /** Release granularity in characters (default 300). */
  segmentChars?: number;
  /**
   * Already-released text re-checked with each segment, counted in compact
   * (separator-free) characters (default MAX_TERM_LENGTH, the longest term a
   * keyword list may hold). Lower it only in tests.
   */
  overlapChars?: number;
}

const isLatinWordChar = (cp: string): boolean => /^[A-Za-z0-9]$/.test(cp);

/**
 * The end of `released` whose compact form has at least `minUnits` UTF-16
 * units. If that would start inside a Latin word, the word is taken whole,
 * plus one more character when a non-separator (e.g. a CJK character) is
 * glued to its front: the ASCII matcher pads the segment with a space, so a
 * cut word would otherwise look like a whole word. If the Latin run is
 * implausibly long (more than 2 × MAX_TERM_LENGTH), its partial start is
 * dropped instead: no whole-word term can start inside it.
 */
export function overlapTail(released: string, minUnits: number): string {
  const cpAt = (i: number) => released.slice(i, nextCodePointEnd(released, i));
  let i = released.length;
  let units = 0;
  while (i > 0 && units < minUnits) {
    const s = prevCodePointStart(released, i);
    units += compactUnits(released.slice(s, i));
    i = s;
  }
  if (i > 0 && i < released.length && isLatinWordChar(cpAt(i))) {
    let j = i;
    let steps = 0;
    while (j > 0 && steps < MAX_TERM_LENGTH * 2) {
      const s = prevCodePointStart(released, j);
      if (!isLatinWordChar(released.slice(s, j))) break;
      j = s;
      steps++;
    }
    if (j === 0) {
      i = 0;
    } else {
      const s = prevCodePointStart(released, j);
      const before = released.slice(s, j);
      if (isLatinWordChar(before)) {
        while (i < released.length && isLatinWordChar(cpAt(i))) i = nextCodePointEnd(released, i);
      } else {
        i = compactUnits(before) === 0 ? j : s;
      }
    }
  }
  return released.slice(i);
}

/**
 * How much of `pending` a non-final segment releases: all of it, unless it
 * ends inside a Latin word, in which case everything before that word (the
 * partial word waits for the next segment, so " ass" is never matched in
 * "assignment"). A pending text that is one Latin run is released whole.
 */
export function releasableLength(pending: string): number {
  let i = pending.length;
  while (i > 0) {
    const s = prevCodePointStart(pending, i);
    if (!isLatinWordChar(pending.slice(s, i))) break;
    i = s;
  }
  return i === 0 ? pending.length : i;
}

export function createOutputStreamGuard(ctx: ContentSafetyContext, opts: OutputStreamGuardOptions = {}): OutputStreamGuard {
  if (!contentSafetyApplies(ctx.brand)) {
    return { push: async (delta) => delta, finish: async () => '' };
  }
  const segmentChars = Math.max(1, opts.segmentChars ?? 300);
  const overlapUnits = Math.max(0, opts.overlapChars ?? MAX_TERM_LENGTH);
  let pending = '';
  /** Text that passed its segment check (all of it reached the caller, except a final segment that the final scan blocks). */
  let released = '';
  let segments = 0;
  let verdict: ContentSafetyVerdict = 'pass';
  const labels = new Set<string>();
  const ruleIds = new Set<string>();
  let provider: string | undefined;
  let listVersion: string | undefined;
  let reason: string | undefined;
  let hitOffset: number | undefined;
  let hitSlice: ContentSafetyHitSlice | undefined;
  let decidedByFinalScan = false;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();

  const summary = (): ContentSafetyResult => ({
    verdict,
    labels: [...labels],
    provider: provider ?? 'unknown',
    ...(ruleIds.size ? { ruleIds: [...ruleIds] } : {}),
    ...(listVersion ? { listVersion } : {}),
    reason: verdict === 'pass' ? 'clean' : reason,
    ...(hitOffset !== undefined ? { hitOffset } : {}),
    ...(hitSlice ? { hitSlice } : {}),
  });

  /** Fold one check result (offsets relative to `base` in released + pending) into the summary. */
  const absorb = (r: ContentSafetyResult, base: number, finalScan: boolean) => {
    provider = provider ?? r.provider;
    listVersion = listVersion ?? r.listVersion;
    if (worstVerdict(verdict, r.verdict) !== verdict) {
      reason = r.reason;
      hitOffset = r.hitOffset !== undefined ? base + r.hitOffset : undefined;
      hitSlice = r.hitSlice ? { ...r.hitSlice, start: base + r.hitSlice.start } : undefined;
      decidedByFinalScan = finalScan;
    }
    verdict = worstVerdict(verdict, r.verdict);
    if (r.verdict !== 'pass') {
      r.labels.forEach((l) => labels.add(l));
      r.ruleIds?.forEach((id) => ruleIds.add(id));
    }
  };

  const failClosed = async (err: unknown, text: string): Promise<never> => {
    closed = true;
    if (err instanceof ContentSafetyUnavailableError) {
      await recordContentSafetyEvent(
        buildContentSafetyEvent({ stage: 'output', text, ctx, verdict: 'error', cause: err.details.cause, segments }),
      );
    }
    throw err;
  };

  const blocked = async (text: string, blockedLabels: string[]): Promise<never> => {
    closed = true;
    await recordContentSafetyEvent(
      buildContentSafetyEvent({
        stage: 'output',
        text,
        ctx,
        verdict: 'block',
        result: summary(),
        segments,
        finalScan: decidedByFinalScan,
      }),
    );
    throw new ContentBlockedError('output', blockedLabels);
  };

  const checkPending = async (final: boolean): Promise<string> => {
    const cut = final ? pending.length : releasableLength(pending);
    const toCheck = pending.slice(0, cut);
    const tail = overlapTail(released, overlapUnits);
    const base = released.length - tail.length;
    segments++;
    let r: ContentSafetyResult;
    try {
      r = await runCheck('output', tail + toCheck, ctx, { record: false });
    } catch (err) {
      return failClosed(err, released + pending);
    }
    absorb(r, base, false);
    // The row hashes everything produced so far; the excerpt is centred on the hit.
    if (r.verdict === 'block') return blocked(released + pending, r.labels);
    released += toCheck;
    pending = pending.slice(cut);
    return toCheck;
  };

  /** Keyword list over the whole released text: a last check that costs no provider call. */
  const finalScan = async (): Promise<void> => {
    const keywordProvider = getContentSafetyProvider().keywordProvider;
    if (!keywordProvider || !released) return;
    let r: ContentSafetyResult;
    try {
      r = await runCheck('output', released, ctx, { record: false, provider: keywordProvider });
    } catch (err) {
      return failClosed(err, released);
    }
    absorb(r, 0, true);
    if (r.verdict === 'block') await blocked(released, r.labels);
  };

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    push(delta) {
      return serial(async () => {
        if (closed) throw new Error('content-safety stream guard is closed');
        pending += delta;
        return codePointLength(pending) >= segmentChars ? checkPending(false) : '';
      });
    },
    finish() {
      return serial(async () => {
        if (closed) throw new Error('content-safety stream guard is closed');
        const out = pending ? await checkPending(true) : '';
        await finalScan();
        closed = true;
        await recordContentSafetyEvent(
          buildContentSafetyEvent({
            stage: 'output',
            text: released,
            ctx,
            verdict,
            result: summary(),
            segments,
            finalScan: decidedByFinalScan && verdict !== 'pass',
          }),
        );
        return out;
      });
    },
  };
}
