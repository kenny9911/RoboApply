// server/src/platform/sse.ts
//
// Server-Sent Events helper for streaming routes (assistant replies, tailor
// progress, onboarding matching). One place sets the headers proxies need,
// keeps the connection alive and stops work when the client goes away.
//
//   router.post('/stream', async (req, res) => {
//     const sse = openSse(req, res);
//     for await (const chunk of llm.stream({ signal: sse.signal })) sse.send('delta', chunk);
//     sse.close();
//   });
//
// - Headers: `text/event-stream`, `no-cache, no-transform`, keep-alive,
//   `X-Accel-Buffering: no` (nginx/Vercel do not buffer).
// - Heartbeat: a `: ping` comment every 15 s so idle proxies keep the socket.
// - Abort: `signal` fires when the client disconnects (the response's
//   `close` event; `req` 'close' is NOT used because since Node 16 it fires
//   as soon as the request body has been read); pass it to the LLM call so an
//   abandoned stream stops spending tokens.

import type { Request, Response } from 'express';

export const SSE_HEARTBEAT_MS = 15_000;

export interface SseOptions {
  heartbeatMs?: number;
  /** Client reconnect delay hint (`retry:` field). */
  retryMs?: number;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

export interface SseStream {
  /** Send one event. Objects are JSON-encoded; strings are sent as-is (multi-line safe). */
  send(event: string, data: unknown, id?: string): boolean;
  /** Send a comment line (ignored by EventSource). */
  comment(text: string): boolean;
  /** End the stream (idempotent). */
  close(): void;
  /** Aborted when the client disconnects or `close()` runs. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
}

type Closable = { on(event: 'close', listener: () => void): unknown; off?(event: 'close', listener: () => void): unknown };

function encodeData(data: unknown): string {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? null);
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n');
}

function safeField(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

/** Format one SSE frame (exported for tests and non-Express writers). */
export function formatSseEvent(event: string | null, data: unknown, id?: string): string {
  let frame = '';
  if (id !== undefined) frame += `id: ${safeField(id)}\n`;
  if (event) frame += `event: ${safeField(event)}\n`;
  frame += `${encodeData(data)}\n\n`;
  return frame;
}

export function openSse(_req: Request | Closable, res: Response, options: SseOptions = {}): SseStream {
  const controller = new AbortController();
  let closed = false;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  for (const [k, v] of Object.entries(options.headers ?? {})) res.setHeader(k, v);
  (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

  const flush = () => (res as Response & { flush?: () => void }).flush?.();

  const write = (chunk: string): boolean => {
    if (closed || res.writableEnded) return false;
    try {
      res.write(chunk);
      flush();
      return true;
    } catch {
      teardown();
      return false;
    }
  };

  if (options.retryMs !== undefined) write(`retry: ${Math.max(0, Math.floor(options.retryMs))}\n\n`);

  const heartbeat = setInterval(() => {
    write(': ping\n\n');
  }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();

  function teardown(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    (res as unknown as Closable).off?.('close', onClose);
    if (!controller.signal.aborted) controller.abort();
  }

  function onClose(): void {
    teardown();
  }

  (res as unknown as Closable).on('close', onClose);

  return {
    send: (event, data, id) => write(formatSseEvent(event, data, id)),
    comment: (text) => write(`: ${safeField(text)}\n\n`),
    close: () => {
      const wasOpen = !closed;
      teardown();
      if (wasOpen && !res.writableEnded) {
        try {
          res.end();
        } catch {
          // already gone
        }
      }
    },
    signal: controller.signal,
    get closed() {
      return closed;
    },
  };
}
