// @vitest-environment node
//
// lib/api/contracts/wire.ts — the runtime every area wrapper shares (FND-7).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoboApiError } from '../../lib/api/client';
import {
  apiErrorCode,
  apiErrorDetails,
  apiUrl,
  call,
  newIdempotencyKey,
  parseSseBlock,
  postStream,
  seg,
  withQuery,
  type SseEvent,
} from '../../lib/api/contracts/wire';

afterEach(() => vi.unstubAllGlobals());

function captureFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('withQuery / seg / apiUrl', () => {
  it('drops null and undefined, repeats arrays, encodes dates and values', () => {
    const at = new Date('2026-10-10T00:00:00.000Z');
    expect(withQuery('/x', { a: 'b c', n: 0, t: true, none: undefined, nil: null, arr: ['1', '2'], at })).toBe(
      '/x?a=b+c&n=0&t=true&arr=1&arr=2&at=2026-10-10T00%3A00%3A00.000Z',
    );
  });

  it('returns the path unchanged for an empty query and appends to an existing query string', () => {
    expect(withQuery('/x', undefined)).toBe('/x');
    expect(withQuery('/x', {})).toBe('/x');
    expect(withQuery('/x?a=1', { b: 2 })).toBe('/x?a=1&b=2');
  });

  it('encodes path segments', () => {
    expect(seg('a/b c')).toBe('a%2Fb%20c');
    expect(seg(5)).toBe('5');
  });

  it('builds absolute URLs from API_BASE (empty in tests)', () => {
    expect(apiUrl('/api/v1/x')).toBe('/api/v1/x');
  });

  it('makes unique idempotency keys', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe('call()', () => {
  it('unwraps the envelope and sends the Idempotency-Key header', async () => {
    const calls = captureFetch(() => json({ success: true, data: { ok: 1 } }));
    const out = await call<{ ok: number }>('POST', '/api/v1/roboapply/x', { body: { a: 1 }, idempotencyKey: 'k-1', headers: { 'X-Extra': 'y' } });
    expect(out).toEqual({ ok: 1 });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('k-1');
    expect(headers['X-Extra']).toBe('y');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('surfaces the platform error code and details (credits_exhausted)', async () => {
    captureFetch(() =>
      json({ success: false, code: 'credits_exhausted', error: 'No tailor credits left', details: { bucket: 'tailor', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true } }, 402),
    );
    const err = await call('POST', '/api/v1/roboapply/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoboApiError);
    expect((err as RoboApiError).status).toBe(402);
    expect(apiErrorCode(err)).toBe('credits_exhausted');
    expect(apiErrorDetails(err)).toEqual({ bucket: 'tailor', resetsAt: '2026-10-11T00:00:00.000Z', upgradable: true });
    expect(apiErrorCode(new Error('x'))).toBeNull();
    expect(apiErrorDetails(new Error('x'))).toBeNull();
  });

  it('sends multipart bodies untouched and without a JSON content type', async () => {
    const calls = captureFetch(() => json({ success: true, data: {} }));
    const form = new FormData();
    form.set('file', 'x');
    await call('POST', '/api/v1/public/tools/resume-check', { body: form, multipart: true });
    expect(calls[0]!.init.body).toBe(form);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});

describe('server-sent events', () => {
  it('parses event/data blocks, joins multi-line data and skips heartbeats', () => {
    expect(parseSseBlock(': ping')).toBeNull();
    expect(parseSseBlock('event: delta\ndata: {"text":"hi"}')).toEqual({ event: 'delta', data: { text: 'hi' } });
    expect(parseSseBlock('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
  });

  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  it('delivers events split across network chunks, in order', async () => {
    const calls = captureFetch(
      () =>
        new Response(
          streamOf(['event: meta\ndata: {"threadId":"t1","messageId":"m1"}\n\n: ping\n\nevent: del', 'ta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo"}\n', '\nevent: done\ndata: {"messageId":"m1"}\n\n']),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const events: SseEvent[] = [];
    await postStream('/api/v1/roboapply/copilot/threads/t1/messages', { text: 'hi' }, { onEvent: (e) => events.push(e), idempotencyKey: 'k' });
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(events[1]!.data).toEqual({ text: 'Hel' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers['Idempotency-Key']).toBe('k');
    expect(calls[0]!.init.credentials).toBe('include');
  });

  it('rejects with RoboApiError when the server refuses before streaming', async () => {
    captureFetch(() => json({ success: false, code: 'feature_disabled', error: 'Not available' }, 404));
    const err = await postStream('/x', {}, { onEvent: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoboApiError);
    expect(apiErrorCode(err)).toBe('feature_disabled');
  });

  it('maps a network failure to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const err = await postStream('/x', {}, { onEvent: () => {} }).catch((e: unknown) => e);
    expect((err as RoboApiError).code).toBe('network_error');
  });
});
