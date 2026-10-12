// DashScope duplex WebSocket task protocol (Model Studio, mainland endpoint).
//
// Both Paraformer realtime STT and CosyVoice streaming TTS speak the same
// envelope over `wss://dashscope.aliyuncs.com/api-ws/v1/inference/`:
//
//   client → {"header":{"action":"run-task","task_id",…,"streaming":"duplex"},
//             "payload":{"task_group":"audio","task","function","model","parameters","input":{}}}
//   server → {"header":{"event":"task-started","task_id"}}
//   client → binary PCM (STT) | {"header":{"action":"continue-task"},"payload":{"input":{"text"}}} (TTS)
//   server → {"header":{"event":"result-generated"},"payload":{"output":…,"usage":…}} | binary PCM (TTS)
//   client → {"header":{"action":"finish-task"},"payload":{"input":{}}}
//   server → {"header":{"event":"task-finished"}} | {"header":{"event":"task-failed","error_code","error_message"}}
//
// Authentication is the `Authorization: bearer <DASHSCOPE_API_KEY>` header on
// the upgrade request (Node's built-in WebSocket accepts `headers`). No new
// dependency: the socket is the runtime's global WebSocket, injectable for the
// fixture-replay tests (replay.ts).

import { randomUUID } from 'node:crypto';
import { APIConnectionError, APIStatusError, APITimeoutError } from '@livekit/agents';

export const DASHSCOPE_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';

/** The subset of the WHATWG WebSocket the protocol needs. */
export interface DashScopeSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => DashScopeSocket;

const OPEN = 1;

export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as DashScopeSocket;

export interface DashScopeConnection {
  apiKey: string;
  /** Defaults to DASHSCOPE_WS_URL. */
  url?: string;
  /** Optional Model Studio workspace id (X-DashScope-WorkSpace). */
  workspace?: string;
  socketFactory?: SocketFactory;
  /** Connect + task-started budget (ms). */
  connectTimeoutMs?: number;
}

export interface DuplexTaskSpec {
  task: 'asr' | 'tts';
  function: 'recognition' | 'SpeechSynthesizer';
  model: string;
  parameters: Record<string, unknown>;
}

export interface DashScopeEnvelope {
  header?: {
    task_id?: string;
    event?: string;
    error_code?: string;
    error_message?: string;
    attributes?: Record<string, unknown>;
  };
  payload?: {
    output?: Record<string, unknown>;
    usage?: Record<string, unknown> | null;
  };
}

export interface DuplexTaskHandlers {
  onResult?: (payload: NonNullable<DashScopeEnvelope['payload']>) => void;
  onAudio?: (bytes: Uint8Array) => void;
}

// error_code values that a reconnect can plausibly fix (throttling, server
// side faults, idle timeouts). Anything else (bad key, unpaid account,
// invalid parameter, unknown model, content inspection) is final.
const RETRYABLE_CODE = /throttl|internal|unavailable|timeout|timed.?out|busy|overload|rate/i;
const FINAL_CODE = /invalid|access.?denied|unauthori|forbidden|arrearage|not.?found|inspection|quota|parameter|bad.?request/i;

/** Map a `task-failed` envelope to the SDK's retry-aware error. */
export function taskFailedError(header: NonNullable<DashScopeEnvelope['header']>, taskId: string): APIStatusError {
  const code = header.error_code ?? 'UNKNOWN';
  const message = header.error_message ?? 'task failed';
  let retryable: boolean;
  if (RETRYABLE_CODE.test(code)) retryable = true;
  else if (FINAL_CODE.test(code)) retryable = false;
  // Generic CLIENT_ERROR: only the idle/request timeouts are worth a reconnect.
  else if (/client/i.test(code)) retryable = RETRYABLE_CODE.test(message);
  else retryable = true;
  return new APIStatusError({
    message: `DashScope task failed: ${code}: ${message}`,
    options: { statusCode: retryable ? 503 : 400, requestId: taskId, retryable, body: { code, message } },
  });
}

/**
 * One DashScope duplex task on its own socket. `start()` resolves once the
 * server reported task-started; `done` settles on task-finished (resolve) or
 * task-failed / unexpected close / abort (reject). Results and audio are
 * pushed to the handlers as they arrive.
 */
export class DuplexTask {
  readonly taskId: string;
  readonly done: Promise<void>;
  private socket: DashScopeSocket | null = null;
  private settled = false;
  private finishing = false;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private abortListener: (() => void) | null = null;

  private constructor(
    private readonly conn: DashScopeConnection,
    private readonly spec: DuplexTaskSpec,
    private readonly handlers: DuplexTaskHandlers,
    private readonly signal?: AbortSignal,
    taskId?: string,
  ) {
    this.taskId = taskId ?? randomUUID().replace(/-/g, '');
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Callers that never await `done` (abort paths) must not surface an
    // unhandled rejection.
    this.done.catch(() => {});
  }

  static async start(
    conn: DashScopeConnection,
    spec: DuplexTaskSpec,
    handlers: DuplexTaskHandlers,
    signal?: AbortSignal,
    taskId?: string,
  ): Promise<DuplexTask> {
    const task = new DuplexTask(conn, spec, handlers, signal, taskId);
    await task.open();
    return task;
  }

  private open(): Promise<void> {
    if (!this.conn.apiKey) {
      return Promise.reject(new APIStatusError({
        message: 'DASHSCOPE_API_KEY is not set',
        options: { statusCode: 401, retryable: false },
      }));
    }
    if (this.signal?.aborted) {
      return Promise.reject(new APIConnectionError({ message: 'aborted before connect', options: { retryable: false } }));
    }
    const headers: Record<string, string> = {
      Authorization: `bearer ${this.conn.apiKey}`,
      'user-agent': 'roboapply-interview-agent',
    };
    if (this.conn.workspace) headers['X-DashScope-WorkSpace'] = this.conn.workspace;
    const factory = this.conn.socketFactory ?? defaultSocketFactory;
    const timeoutMs = this.conn.connectTimeoutMs ?? 10_000;

    return new Promise<void>((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => {
        if (started) return;
        const error = new APITimeoutError({ message: `DashScope task did not start within ${timeoutMs}ms` });
        this.fail(error);
        reject(error);
      }, timeoutMs);
      const onStartFailure = (error: Error) => {
        if (started) return;
        clearTimeout(timer);
        reject(error);
      };

      let socket: DashScopeSocket;
      try {
        socket = factory(this.conn.url || DASHSCOPE_WS_URL, headers);
      } catch (error) {
        clearTimeout(timer);
        reject(new APIConnectionError({ message: `DashScope connect failed: ${errorText(error)}` }));
        return;
      }
      this.socket = socket;
      socket.binaryType = 'arraybuffer';

      if (this.signal) {
        this.abortListener = () => {
          const error = new APIConnectionError({ message: 'aborted', options: { retryable: false } });
          onStartFailure(error);
          this.fail(error);
        };
        this.signal.addEventListener('abort', this.abortListener, { once: true });
      }

      socket.onopen = () => {
        this.sendJson({
          header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: this.spec.task,
            function: this.spec.function,
            model: this.spec.model,
            parameters: this.spec.parameters,
            input: {},
          },
        });
      };
      socket.onerror = (ev) => {
        const error = new APIConnectionError({ message: `DashScope socket error: ${errorText(ev)}` });
        onStartFailure(error);
        this.fail(error);
      };
      socket.onclose = (ev) => {
        if (this.settled) return;
        const error = new APIConnectionError({
          message: `DashScope socket closed before the task finished (code=${ev?.code ?? 'unknown'}${ev?.reason ? ` reason=${ev.reason}` : ''})`,
        });
        onStartFailure(error);
        this.fail(error);
      };
      socket.onmessage = (ev) => {
        const data = ev.data;
        if (typeof data !== 'string') {
          const bytes = toBytes(data);
          if (bytes && bytes.byteLength > 0) this.handlers.onAudio?.(bytes);
          return;
        }
        let envelope: DashScopeEnvelope;
        try {
          envelope = JSON.parse(data) as DashScopeEnvelope;
        } catch {
          return; // not ours to interpret
        }
        const header = envelope.header ?? {};
        switch (header.event) {
          case 'task-started':
            started = true;
            clearTimeout(timer);
            resolve();
            break;
          case 'result-generated':
            if (envelope.payload) this.handlers.onResult?.(envelope.payload);
            break;
          case 'task-finished':
            if (envelope.payload) this.handlers.onResult?.(envelope.payload);
            this.settle();
            break;
          case 'task-failed': {
            const error = taskFailedError(header, this.taskId);
            onStartFailure(error);
            this.fail(error);
            break;
          }
          default:
            break;
        }
      };
    });
  }

  /** Stream PCM audio (STT). */
  sendAudio(bytes: Uint8Array): void {
    if (this.settled || this.finishing || !this.socket || this.socket.readyState !== OPEN) return;
    this.socket.send(bytes);
  }

  /** Stream text to synthesize (TTS). */
  continueText(text: string): void {
    if (!text || this.settled || this.finishing) return;
    this.sendJson({
      header: { action: 'continue-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { input: { text } },
    });
  }

  /** No more input: ask the server to flush, then wait for task-finished. */
  async finish(): Promise<void> {
    if (!this.settled && !this.finishing) {
      this.finishing = true;
      this.sendJson({
        header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
        payload: { input: {} },
      });
    }
    await this.done;
  }

  /** Tear down without waiting (abort / error paths). Idempotent. */
  close(): void {
    if (!this.settled) {
      this.fail(new APIConnectionError({ message: 'task closed', options: { retryable: false } }));
    } else {
      this.closeSocket();
    }
  }

  private sendJson(body: unknown): void {
    if (!this.socket || this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(body));
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolveDone();
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.rejectDone(error);
  }

  private cleanup(): void {
    if (this.abortListener && this.signal) this.signal.removeEventListener('abort', this.abortListener);
    this.abortListener = null;
    this.closeSocket();
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'done');
    } catch {
      /* already closed */
    }
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  const maybe = value as { message?: unknown; error?: unknown } | null;
  if (maybe && typeof maybe.message === 'string') return maybe.message;
  if (maybe && maybe.error instanceof Error) return maybe.error.message;
  return String(value);
}
