// Worker → control-plane callback delivery (contract C11).
//
// - Every transcript turn carries `key = role + ':' + ts`; the control plane
//   dedupes on (role, ts) when appending, which is what makes retrying a
//   transcript POST after a 5xx safe.
// - Transcript POSTs are batched at <= 100 turns (the control plane's per-call
//   cap — a larger body was silently truncated).
// - Retry policy: network errors, 5xx, 408, 409 and 429 retry with backoff (max
//   3 retries); any other 4xx is FINAL (auth/not-found/validation will not get
//   better by resending) and the batch is dropped with a log line.
//
// Pure module (fetch/sleep are injected) so the policy is unit-testable.

export const CALLBACK_MAX_RETRIES = 3; // 1 try + 3 retries per POST
export const CALLBACK_RETRY_BASE_MS = 600; // backoff: 600 / 1200 / 1800 ms
export const CALLBACK_TIMEOUT_MS = 8_000;
export const TRANSCRIPT_MAX_BATCH = 100;

export type TranscriptRole = 'candidate' | 'interviewer' | 'system';

export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
  /** epoch ms; unique per role within a session (see TurnClock). */
  ts: number;
  /** Idempotency key: `${role}:${ts}`. */
  key: string;
}

/**
 * 'delivered' — 2xx.
 * 'rejected'  — a final 4xx; resending cannot help, drop the payload.
 * 'lost'      — every attempt hit a network error / retryable status; the
 *               caller may keep the payload and retry later.
 * 'skipped'   — no callback base URL configured.
 */
export type PostResult = 'delivered' | 'rejected' | 'lost' | 'skipped';

export type StatusClass = 'ok' | 'retry' | 'final';

export function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 500) return 'retry';
  if (status === 408 || status === 409 || status === 429) return 'retry';
  return 'final';
}

export function turnKey(role: string, ts: number): string {
  return `${role}:${ts}`;
}

/** Hands out epoch-ms timestamps that strictly increase per role, so two turns
 *  of the same role in the same millisecond never collide on the (role, ts)
 *  dedupe key. */
export class TurnClock {
  private readonly last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  next(role: string): number {
    const prev = this.last.get(role) ?? 0;
    const ts = Math.max(this.now(), prev + 1);
    this.last.set(role, ts);
    return ts;
  }
}

export function makeTurn(role: TranscriptRole, text: string, ts: number): TranscriptTurn {
  return { role, text, ts, key: turnKey(role, ts) };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface PosterOptions {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

export type Poster = (path: string, body: unknown, maxRetries?: number) => Promise<PostResult>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

export function createPoster(opts: PosterOptions): Poster {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retryBaseMs = opts.retryBaseMs ?? CALLBACK_RETRY_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const warn = opts.warn ?? (() => {});

  return async (path, body, maxRetries = opts.maxRetries ?? CALLBACK_MAX_RETRIES) => {
    if (!baseUrl) return 'skipped';
    const payload = JSON.stringify(body);
    const attempts = Math.max(1, maxRetries + 1);
    let lastProblem = 'unknown';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-interview-callback-secret': opts.secret },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const cls = classifyStatus(res.status);
        if (cls === 'ok') return 'delivered';
        if (cls === 'final') {
          warn(`control-plane POST ${path} -> HTTP ${res.status} (final, not retried)`);
          return 'rejected';
        }
        lastProblem = `HTTP ${res.status}`;
      } catch (err) {
        lastProblem = err instanceof Error ? err.message : String(err);
      }
      if (attempt < attempts) await sleep(retryBaseMs * attempt);
    }
    warn(`control-plane POST ${path} failed after ${attempts} attempt(s): ${lastProblem}`);
    return 'lost';
  };
}

/**
 * Buffered transcript delivery. Turns are queued in order and flushed in
 * batches of <= TRANSCRIPT_MAX_BATCH. A 'lost' batch goes back to the FRONT of
 * the queue (order preserved; retried on the next flush / shutdown drain); a
 * 'rejected' batch is dropped.
 */
export class TranscriptSender {
  private readonly buffer: TranscriptTurn[] = [];
  private flushing: Promise<void> | null = null;
  private readonly clock: TurnClock;

  constructor(
    private readonly post: Poster,
    private readonly path: string,
    private readonly opts: {
      bufferCap?: number;
      batchSize?: number;
      now?: () => number;
      warn?: (message: string) => void;
    } = {},
  ) {
    this.clock = new TurnClock(opts.now);
  }

  get pending(): number { return this.buffer.length; }

  /** Queue a turn; returns it (with its ts/key) or null for blank text. */
  add(role: TranscriptRole, text: string): TranscriptTurn | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const cap = this.opts.bufferCap ?? 2_000;
    // Bound memory if the backend stays unreachable (drop the oldest).
    if (this.buffer.length >= cap) this.buffer.shift();
    const turn = makeTurn(role, trimmed, this.clock.next(role));
    this.buffer.push(turn);
    return turn;
  }

  clear(): void { this.buffer.length = 0; }

  /** Send everything currently buffered. Concurrent callers share one pass. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return Promise.resolve();
    this.flushing = this.runFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    const size = this.opts.batchSize ?? TRANSCRIPT_MAX_BATCH;
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, Math.min(size, this.buffer.length));
      const result = await this.post(this.path, { turns: batch });
      if (result === 'lost') {
        // Turns that arrived during the await stay behind the failed batch.
        this.buffer.unshift(...batch);
        return;
      }
      if (result === 'rejected') {
        this.opts.warn?.(`transcript batch of ${batch.length} turn(s) rejected by the control plane; dropped`);
      }
      if (result === 'skipped') return;
    }
  }
}

/**
 * Interviewer turns spoken from KNOWN text (the greeting / first question via
 * session.say) are recorded when the speech is created, so a session that is
 * finalized mid-greeting still has the interviewer turn. The SDK later emits
 * the same text as a ConversationItemAdded at playout end (truncated to the
 * spoken part when interrupted); this tracker swallows that duplicate once.
 */
export class EagerTurnDeduper {
  private readonly pending: string[] = [];

  static normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }

  remember(text: string): void {
    const t = EagerTurnDeduper.normalize(text);
    if (t) this.pending.push(t);
  }

  /** True when `text` is the playout echo of a remembered eager turn
   *  (exact, or the truncated head left by an interruption — the SDK's
   *  aligned truncation can end mid-word, so only the leading characters are
   *  compared). Consumes the match. */
  consume(text: string): boolean {
    const t = EagerTurnDeduper.normalize(text);
    if (!t) return false;
    const head = Array.from(t).slice(0, 24).join('');
    const idx = this.pending.findIndex((p) => p === t || p.startsWith(t) || p.startsWith(head));
    if (idx === -1) return false;
    this.pending.splice(idx, 1);
    return true;
  }

  get size(): number { return this.pending.length; }
}
