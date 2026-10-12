// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Router, type Response } from 'express';
import { SSE_HEARTBEAT_MS, formatSseEvent, openSse } from './sse.js';
import { startRouteHarness, type RouteHarness } from '../test/routeHarness.js';

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  statusCode = 0;
  writableEnded = false;
  headersFlushed = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  flushHeaders() {
    this.headersFlushed = true;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
}

function fake() {
  const req = new EventEmitter();
  const res = new FakeRes();
  return { req, res, sse: openSse(req as never, res as unknown as Response) };
}

afterEach(() => vi.useRealTimers());

describe('openSse', () => {
  it('sets the streaming headers and flushes them', () => {
    const { res } = fake();
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    expect(res.headersFlushed).toBe(true);
  });

  it('sends a heartbeat every 15 s until closed', () => {
    vi.useFakeTimers();
    const { res, sse } = fake();
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
    vi.advanceTimersByTime(14_999);
    expect(res.chunks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(res.chunks).toEqual([': ping\n\n']);
    vi.advanceTimersByTime(30_000);
    expect(res.chunks).toHaveLength(3);
    sse.close();
    vi.advanceTimersByTime(60_000);
    expect(res.chunks).toHaveLength(3);
    expect(res.writableEnded).toBe(true);
  });

  it('aborts its signal when the client goes away and stops writing', () => {
    vi.useFakeTimers();
    const { res, sse } = fake();
    const onAbort = vi.fn();
    sse.signal.addEventListener('abort', onAbort);
    res.emit('close');
    expect(onAbort).toHaveBeenCalledOnce();
    expect(sse.closed).toBe(true);
    expect(sse.send('delta', { t: 'x' })).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(res.chunks).toEqual([]);
  });

  it('does not abort when only the request body finished (Node fires req close early)', () => {
    const { req, sse } = fake();
    req.emit('close');
    expect(sse.signal.aborted).toBe(false);
    sse.close();
  });

  it('formats events, ids and multi-line data', () => {
    expect(formatSseEvent('delta', { a: 1 }, '7')).toBe('id: 7\nevent: delta\ndata: {"a":1}\n\n');
    expect(formatSseEvent(null, 'line1\nline2')).toBe('data: line1\ndata: line2\n\n');
    expect(formatSseEvent('bad\nname', 'x')).toBe('event: bad name\ndata: x\n\n');
  });
});

describe('openSse over HTTP', () => {
  let h: RouteHarness;
  beforeAll(async () => {
    const r = Router();
    r.post('/stream', (req, res) => {
      const sse = openSse(req, res, { retryMs: 3000 });
      sse.send('delta', { text: 'Hel' });
      sse.send('delta', { text: 'lo' }, '2');
      sse.send('done', { ok: true });
      sse.close();
    });
    h = await startRouteHarness({ mounts: [['/s', r]] });
  });
  afterAll(() => h.close());

  it('streams the events to a real client (POST body read does not abort the stream)', async () => {
    const res = await h.request('POST', '/s/stream', { body: { q: 'hi' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.text).toBe(
      'retry: 3000\n\nevent: delta\ndata: {"text":"Hel"}\n\nid: 2\nevent: delta\ndata: {"text":"lo"}\n\nevent: done\ndata: {"ok":true}\n\n',
    );
  });
});
