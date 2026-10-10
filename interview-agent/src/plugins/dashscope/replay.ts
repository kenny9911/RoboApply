// Websocket fixtures for the DashScope plugins: a replaying fake socket (tests,
// offline smoke runs) and a recording wrapper around the real socket
// (record-fixture.ts). No network in replay mode.
//
// Fixture = the ordered frames of one task, both directions:
//   { dir: 'client', action: 'run-task' | 'continue-task' | 'finish-task' }
//   { dir: 'client', binaryBytes: n }        client audio, at least n bytes
//   { dir: 'server', json: {...} }           "{{task_id}}" stands for the task id
//   { dir: 'server', base64: '...' }         server audio (PCM)
//   { dir: 'server', close: { code, reason } }
// Replay walks the frames in order: server frames are delivered as soon as
// every client frame before them has been seen; client frames are expectations
// checked against what the plugin sends, in order (a client may run ahead of
// the server, as on a real socket); mismatches land in `violations`.

import type { DashScopeSocket, SocketFactory } from './protocol.js';

export type FixtureFrame =
  | { dir: 'client'; action: 'run-task' | 'continue-task' | 'finish-task' }
  | { dir: 'client'; binaryBytes: number }
  | { dir: 'server'; json: unknown }
  | { dir: 'server'; base64: string }
  | { dir: 'server'; close: { code: number; reason?: string } };

export interface DashScopeFixture {
  name: string;
  kind: 'stt' | 'tts';
  /** Where the frames came from (live capture via record-fixture, or protocol reference). */
  source: string;
  model: string;
  frames: FixtureFrame[];
}

export const TASK_ID_PLACEHOLDER = '{{task_id}}';

export type SentMessage =
  | { type: 'json'; body: { header?: { action?: string; task_id?: string }; payload?: Record<string, unknown> } }
  | { type: 'binary'; bytes: number };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function substitute(value: unknown, taskId: string): unknown {
  if (typeof value === 'string') return value === TASK_ID_PLACEHOLDER ? taskId : value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, taskId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, taskId)]));
  }
  return value;
}

/** Fake socket replaying one fixture. */
export class ReplaySocket implements DashScopeSocket {
  readyState = CONNECTING;
  binaryType = 'blob';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  readonly sent: SentMessage[] = [];
  readonly violations: string[] = [];
  closedByClient = false;
  private cursor = 0;
  private pendingBinary = 0;
  private taskId = '';
  private delivering = false;
  /** Client expectations already met (a client may run ahead of the server's frames). */
  private readonly satisfied = new Set<number>();

  constructor(
    readonly fixture: DashScopeFixture,
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    setImmediate(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({});
      void this.deliver();
    });
  }

  /** True once every fixture frame has been consumed. */
  get exhausted(): boolean {
    return this.cursor >= this.fixture.frames.length;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.readyState !== OPEN) {
      this.violations.push('send on a socket that is not open');
      return;
    }
    if (typeof data === 'string') {
      const body = JSON.parse(data) as Extract<SentMessage, { type: 'json' }>['body'];
      this.sent.push({ type: 'json', body });
      const action = body.header?.action;
      if (action === 'run-task') this.taskId = body.header?.task_id ?? '';
      const idx = this.nextClientIndex();
      const expected = idx >= 0 ? this.fixture.frames[idx] : undefined;
      if (expected && expected.dir === 'client' && 'action' in expected && expected.action === action) {
        this.satisfied.add(idx);
        this.pendingBinary = 0;
        void this.deliver();
      } else if (action !== 'continue-task') {
        // Extra continue-task messages are normal (text streams token by
        // token); any other unexpected action is a protocol violation.
        const wanted = expected && expected.dir === 'client' && 'action' in expected ? ` (expected ${expected.action})` : '';
        this.violations.push(`frame ${idx}: unexpected ${action}${wanted}`);
      }
      return;
    }
    const bytes = ArrayBuffer.isView(data) ? data.byteLength : (data as ArrayBuffer).byteLength;
    this.sent.push({ type: 'binary', bytes });
    const idx = this.nextClientIndex();
    const expected = idx >= 0 ? this.fixture.frames[idx] : undefined;
    if (expected && expected.dir === 'client' && 'binaryBytes' in expected) {
      this.pendingBinary += bytes;
      if (this.pendingBinary >= expected.binaryBytes) {
        this.satisfied.add(idx);
        this.pendingBinary = 0;
        void this.deliver();
      }
    }
    // Audio beyond what the fixture waits for is normal (real-time stream).
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.closedByClient = true;
    this.readyState = CLOSED;
    const handler = this.onclose;
    setImmediate(() => handler?.({ code: code ?? 1000, reason: reason ?? '' }));
  }

  /** Index of the first client expectation not yet met, or -1. */
  private nextClientIndex(): number {
    const frames = this.fixture.frames;
    for (let i = this.cursor; i < frames.length; i += 1) {
      if (frames[i]!.dir === 'client' && !this.satisfied.has(i)) return i;
    }
    return -1;
  }

  /** Deliver server frames up to the next unmet client expectation. */
  private async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.readyState === OPEN && this.cursor < this.fixture.frames.length) {
        const frame = this.fixture.frames[this.cursor]!;
        if (frame.dir === 'client') {
          if (!this.satisfied.has(this.cursor)) return;
          this.cursor += 1;
          continue;
        }
        this.cursor += 1;
        await new Promise<void>((r) => setImmediate(r));
        if (this.readyState !== OPEN) return;
        if ('json' in frame) {
          this.onmessage?.({ data: JSON.stringify(substitute(frame.json, this.taskId)) });
        } else if ('base64' in frame) {
          const buf = Buffer.from(frame.base64, 'base64');
          this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
        } else if ('close' in frame) {
          this.readyState = CLOSED;
          this.onclose?.({ code: frame.close.code, reason: frame.close.reason ?? '' });
          return;
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}

/** Socket factory that replays fixtures in order (one per connection) and keeps every socket for assertions. */
export function replayFactory(...fixtures: DashScopeFixture[]): SocketFactory & { sockets: ReplaySocket[] } {
  const sockets: ReplaySocket[] = [];
  const factory: SocketFactory = (url, headers) => {
    const fixture = fixtures[Math.min(sockets.length, fixtures.length - 1)];
    if (!fixture) throw new Error('replayFactory needs at least one fixture');
    const socket = new ReplaySocket(fixture, url, headers);
    sockets.push(socket);
    return socket;
  };
  return Object.assign(factory, { sockets });
}

/**
 * Wrap a real socket factory and record the exchange as fixture frames.
 * The task id is replaced by the placeholder, and API keys never enter the
 * fixture (headers are not recorded).
 */
export function recordingFactory(inner: SocketFactory, frames: FixtureFrame[]): SocketFactory {
  return (url, headers) => {
    const socket = inner(url, headers);
    let taskId = '';
    const scrub = (text: string): unknown => {
      const parsed = JSON.parse(text) as unknown;
      const replace = (value: unknown): unknown => {
        if (typeof value === 'string') return taskId && value === taskId ? TASK_ID_PLACEHOLDER : value;
        if (Array.isArray(value)) return value.map(replace);
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
        }
        return value;
      };
      return replace(parsed);
    };
    const proxy: DashScopeSocket = {
      get readyState() { return socket.readyState; },
      get binaryType() { return socket.binaryType; },
      set binaryType(v: string) { socket.binaryType = v; },
      send(data) {
        if (typeof data === 'string') {
          const body = JSON.parse(data) as { header?: { action?: string; task_id?: string } };
          if (body.header?.action === 'run-task') taskId = body.header.task_id ?? '';
          const action = body.header?.action;
          if (action === 'run-task' || action === 'continue-task' || action === 'finish-task') {
            frames.push({ dir: 'client', action });
          }
        } else {
          const bytes = ArrayBuffer.isView(data) ? data.byteLength : (data as ArrayBuffer).byteLength;
          const last = frames[frames.length - 1];
          if (last && last.dir === 'client' && 'binaryBytes' in last) last.binaryBytes += bytes;
          else frames.push({ dir: 'client', binaryBytes: bytes });
        }
        socket.send(data);
      },
      close(code, reason) { socket.close(code, reason); },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    socket.onopen = (ev) => proxy.onopen?.(ev);
    socket.onerror = (ev) => proxy.onerror?.(ev);
    socket.onclose = (ev) => proxy.onclose?.(ev);
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') frames.push({ dir: 'server', json: scrub(ev.data) });
      else if (ev.data instanceof ArrayBuffer) frames.push({ dir: 'server', base64: Buffer.from(ev.data).toString('base64') });
      proxy.onmessage?.(ev);
    };
    return proxy;
  };
}
