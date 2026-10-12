// Envelope unwrapping in lib/api/client.ts.
//
// The server answers `{ success: true, data: <payload> }`. A payload of `null`
// is a real answer ("you have no report yet", "no active plan") and must reach
// the caller as `null`. It used to come back as the whole envelope, because
// the unwrap was `data?.data ?? data` and `??` cannot tell "no data key" from
// "data is null" — so /jobs/report rendered `{ success, data }` as a report
// and crashed formatting `new Date(undefined)`.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { request, roboApi, unwrapEnvelope } from './client';

function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unwrapEnvelope', () => {
  it('returns null for an envelope whose data is null', () => {
    expect(unwrapEnvelope({ success: true, data: null })).toBeNull();
  });

  it('returns the payload of an envelope, including falsy payloads', () => {
    expect(unwrapEnvelope({ success: true, data: { id: 'r1' } })).toEqual({ id: 'r1' });
    expect(unwrapEnvelope({ success: true, data: [] })).toEqual([]);
    expect(unwrapEnvelope({ success: true, data: 0 })).toBe(0);
    expect(unwrapEnvelope({ success: true, data: false })).toBe(false);
    expect(unwrapEnvelope({ success: true, data: '' })).toBe('');
  });

  it('unwraps a bare { data } wrapper that carries a payload', () => {
    expect(unwrapEnvelope({ data: { id: 'r1' } })).toEqual({ id: 'r1' });
  });

  it('leaves a body with no data key alone', () => {
    expect(unwrapEnvelope({ success: true })).toEqual({ success: true });
    expect(unwrapEnvelope({ success: true, items: [1] })).toEqual({ success: true, items: [1] });
    expect(unwrapEnvelope({})).toEqual({});
  });

  it('leaves non-envelope bodies alone', () => {
    expect(unwrapEnvelope([{ data: 1 }])).toEqual([{ data: 1 }]);
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope('ok')).toBe('ok');
    // A resource that merely has a nullable field called `data` is not an envelope.
    expect(unwrapEnvelope({ id: 'x', data: null })).toEqual({ id: 'x', data: null });
  });
});

describe('request()', () => {
  it('resolves null when the server answers { success: true, data: null }', async () => {
    respondWith({ success: true, data: null });
    await expect(request('GET', '/api/v1/roboapply/match/competitiveness/latest')).resolves.toBeNull();
    respondWith({ success: true, data: null });
    await expect(roboApi.get('/api/v1/roboapply/match/competitiveness/latest')).resolves.toBeNull();
  });

  it('resolves the payload when there is one', async () => {
    respondWith({ success: true, data: { id: 'r1', generatedAt: '2026-10-11T00:00:00.000Z' } });
    await expect(request('GET', '/x')).resolves.toEqual({ id: 'r1', generatedAt: '2026-10-11T00:00:00.000Z' });
  });

  it('resolves {} for an empty or non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 204,
        json: async () => {
          throw new Error('no body');
        },
      })),
    );
    await expect(request('POST', '/x')).resolves.toEqual({});
  });

  it('still rejects success:false even when data is null', async () => {
    respondWith({ success: false, data: null, error: 'Nope', code: 'not_found' }, { ok: false, status: 404 });
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 404, message: 'Nope' });
  });
});
