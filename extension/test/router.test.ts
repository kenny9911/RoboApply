// Service worker: pairing, code redemption, the token-bearing API client.

import { describe, expect, it, vi } from 'vitest';

import { callApi, isOwnFileUrl } from '../src/background/api';
import { createRouter } from '../src/background/router';
import { AUTH_KEY, memoryStore, RECONNECT_KEY } from '../src/background/storage';
import { getExtBrand } from '../src/brands/index';

const TOKEN = `rax_${'a'.repeat(43)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(opts: { dev?: boolean; brand?: 'roboapply' | 'goapply'; fetch?: ReturnType<typeof vi.fn> } = {}) {
  const store = memoryStore();
  const fetch = opts.fetch ?? vi.fn(async () => json({ success: true, data: {} }));
  const brand = getExtBrand(opts.brand ?? 'roboapply');
  const router = createRouter({
    brand,
    dev: opts.dev ?? false,
    apiOrigin: opts.dev ? 'http://localhost:3611' : brand.apiOrigin,
    version: '1.0.0',
    browserName: 'Chrome',
    store,
    fetch: fetch as never,
    now: () => new Date('2026-10-10T00:00:00Z'),
  });
  return { router, store, fetch };
}

describe('external messages (web page → extension)', () => {
  it('answers ping from the brand site', async () => {
    const { router } = setup();
    expect(await router.handleExternal({ type: 'ping' }, { origin: 'https://www.roboapply.io' })).toEqual({ ok: true, brand: 'roboapply', version: '1.0.0', connected: false });
  });

  it('pairs with a well-formed token from the brand site', async () => {
    const { router, store } = setup();
    expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'https://www.roboapply.io' }, { url: 'https://www.roboapply.io/extension' })).toEqual({ ok: true });
    expect(store.data[AUTH_KEY]).toEqual({ token: TOKEN, apiOrigin: 'https://www.roboapply.io', pairedAt: '2026-10-10T00:00:00.000Z' });
  });

  it('refuses other sites, the other brand, http in production, and dev hosts in production', async () => {
    const { router, store } = setup();
    for (const origin of ['https://evil.example', 'https://www.goapply.top', 'http://www.roboapply.io', 'http://localhost:3611', 'https://roboapply.io.evil.example']) {
      expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'https://www.roboapply.io' }, { origin })).toEqual({ ok: false, code: 'untrusted_origin' });
    }
    expect(store.data[AUTH_KEY]).toBeUndefined();
  });

  it('refuses a malformed token or an API origin of another brand', async () => {
    const { router, store } = setup();
    expect(await router.handleExternal({ type: 'pair', token: 'nope', apiOrigin: 'https://www.roboapply.io' }, { origin: 'https://www.roboapply.io' })).toEqual({ ok: false, code: 'invalid_token' });
    expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'https://www.goapply.top' }, { origin: 'https://www.roboapply.io' })).toEqual({ ok: false, code: 'wrong_brand' });
    expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'https://evil.example' }, { origin: 'https://www.roboapply.io' })).toEqual({ ok: false, code: 'wrong_brand' });
    expect(store.data[AUTH_KEY]).toBeUndefined();
  });

  it('production stores the canonical API origin (the one with host permission), whichever brand host sent the page', async () => {
    for (const apiOrigin of ['https://roboapply.io', 'https://api.roboapply.io', 'https://roboapply.io/']) {
      const { router, store } = setup();
      expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin }, { origin: 'https://roboapply.io' })).toEqual({ ok: true });
      expect(store.data[AUTH_KEY]).toMatchObject({ apiOrigin: getExtBrand('roboapply').apiOrigin.replace(/\/$/, '') });
    }
  });

  it('dev builds accept the local web app', async () => {
    const { router, store } = setup({ dev: true });
    expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'http://localhost:3611' }, { origin: 'http://localhost:3611' })).toEqual({ ok: true });
    expect(store.data[AUTH_KEY]).toMatchObject({ apiOrigin: 'http://localhost:3611' });
  });

  it('GoApply builds pair only with goapply.top', async () => {
    const { router } = setup({ brand: 'goapply' });
    expect(await router.handleExternal({ type: 'pair', token: TOKEN, apiOrigin: 'https://www.goapply.top' }, { origin: 'https://www.goapply.top' })).toEqual({ ok: true });
    expect(await router.handleExternal({ type: 'ping' }, { origin: 'https://www.roboapply.io' })).toEqual({ ok: false, code: 'untrusted_origin' });
  });
});

describe('internal messages', () => {
  it('redeems an 8-character code and stores the token', async () => {
    const fetch = vi.fn(async () => json({ success: true, data: { token: TOKEN } }));
    const { router, store } = setup({ fetch });
    const res = (await router.handleInternal({ type: 'redeem', code: 'ab12-cd34' })) as { ok: boolean; data: { connected: boolean } };
    expect(res.ok).toBe(true);
    expect(res.data.connected).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.roboapply.io/api/v1/roboapply/ext/pair-codes/redeem');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'AB12CD34', name: 'Chrome', browser: 'Chrome', extVersion: '1.0.0' });
    expect((store.data[AUTH_KEY] as { token: string }).token).toBe(TOKEN);
  });

  it('rejects a malformed code without calling the API', async () => {
    const { router, fetch } = setup();
    expect(await router.handleInternal({ type: 'redeem', code: 'short' })).toMatchObject({ ok: false, code: 'pair_code_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('API calls carry the bearer token and an idempotency key; a revoked device asks to reconnect', async () => {
    const fetch = vi.fn(async () => json({ success: false, code: 'unauthorized', error: 'revoked' }, 401));
    const { router, store } = setup({ fetch });
    await store.set(AUTH_KEY, { token: TOKEN, apiOrigin: 'https://www.roboapply.io', pairedAt: 'x' });
    const res = await router.handleInternal({ type: 'api', call: { op: 'createRun', body: { host: 'h', atsType: 'greenhouse', url: 'https://boards.greenhouse.io/x', fieldsTotal: 3 }, idempotencyKey: 'k1' } });
    expect(res).toMatchObject({ ok: false, code: 'unauthorized', status: 401 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.roboapply.io/api/v1/roboapply/ext/autofill-runs');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k1');
    expect(init.credentials).toBe('omit');
    expect(store.data[AUTH_KEY]).toBeUndefined();
    expect(store.data[RECONNECT_KEY]).toBe(true);
    expect(await router.handleInternal({ type: 'status' })).toMatchObject({ connected: false, needsReconnect: true });
  });

  it('without a token, API calls fail locally', async () => {
    const { router, fetch } = setup();
    expect(await router.handleInternal({ type: 'api', call: { op: 'me' } })).toMatchObject({ ok: false, code: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disconnect forgets the token', async () => {
    const { router, store } = setup();
    await store.set(AUTH_KEY, { token: TOKEN, apiOrigin: 'https://www.roboapply.io', pairedAt: 'x' });
    expect(await router.handleInternal({ type: 'disconnect' })).toMatchObject({ connected: false, needsReconnect: false });
  });
});

describe('callApi', () => {
  it('maps PATCH runs and unwraps the envelope', async () => {
    const fetch = vi.fn(async () => json({ success: true, data: { ok: 1 } }));
    const res = await callApi({ apiOrigin: 'https://www.roboapply.io', token: TOKEN, fetch: fetch as never }, { op: 'patchRun', id: 'r/1', body: { fieldsFilled: 2, outcome: 'partial', userMarkedSubmitted: true } });
    expect(res).toEqual({ ok: true, data: { ok: 1 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.roboapply.io/api/v1/roboapply/ext/autofill-runs/r%2F1');
    expect(init.method).toBe('PATCH');
  });

  it('downloads files only from the paired origin’s file route', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Avery.pdf"' } }));
    const deps = { apiOrigin: 'https://www.roboapply.io', token: TOKEN, fetch: fetch as never };
    expect(await callApi(deps, { op: 'fetchFile', url: 'https://evil.example/api/v1/roboapply/ext/files/x' })).toMatchObject({ ok: false, code: 'untrusted_file_url' });
    expect(fetch).not.toHaveBeenCalled();
    const res = await callApi(deps, { op: 'fetchFile', url: '/api/v1/roboapply/ext/files/signed' });
    expect(res).toEqual({ ok: true, data: { base64: btoa('%PDF'), contentType: 'application/pdf', fileName: 'Avery.pdf' } });
    expect(isOwnFileUrl('https://www.roboapply.io', 'https://www.roboapply.io/api/v1/roboapply/ext/me')).toBe(false);
  });

  it('reports network failures without throwing', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await callApi({ apiOrigin: 'https://www.roboapply.io', token: TOKEN, fetch: fetch as never }, { op: 'me' })).toMatchObject({ ok: false, code: 'network_error' });
  });
});
