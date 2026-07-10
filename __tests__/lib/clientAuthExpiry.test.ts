// Stale-session recovery in lib/api/client.ts.
//
// Scenario under test: the edge proxy only checks that the session cookie
// EXISTS, so a browser holding a dead session (row revoked/expired — e.g. by
// the 2026-07 DB split) reaches protected pages and every API call 401s. The
// client must recognise `auth_expired` on a protected route, shed the dead
// credentials (localStorage bearer + cookie via the sessionless logout), and
// hard-navigate to /login?next=… — exactly once, even when a stranded page
// fires a burst of parallel 401s.
//
// The module keeps a fired-once guard, so each test re-imports a fresh copy
// via vi.resetModules() + dynamic import.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INVALID_TOKEN_RESPONSE = {
  ok: false,
  status: 401,
  json: async () => ({
    success: false,
    error: 'Invalid or expired token',
    code: 'INVALID_TOKEN',
  }),
};

const NO_CONTENT_RESPONSE = {
  ok: true,
  status: 204,
  json: async () => {
    throw new Error('no body');
  },
};

function makeFetchMock() {
  return vi.fn(async (url: string) =>
    String(url).includes('/auth/logout')
      ? NO_CONTENT_RESPONSE
      : INVALID_TOKEN_RESPONSE,
  );
}

async function importFreshClient() {
  vi.resetModules();
  return import('../../lib/api/client');
}

function setPath(pathname: string) {
  window.history.replaceState({}, '', pathname);
}

// jsdom's location.assign is unforgeable per spec; spying works in some jsdom
// versions and not others. When it works we also assert the target URL;
// either way the logout call + localStorage clear prove the recovery ran.
function tryMockAssign() {
  try {
    return vi
      .spyOn(window.location, 'assign')
      .mockImplementation(() => undefined);
  } catch {
    return null;
  }
}

describe('RoboApiError code normalisation', () => {
  it("maps the backend's token-failure codes to auth_expired", async () => {
    const { RoboApiError } = await importFreshClient();
    for (const code of ['INVALID_TOKEN', 'NO_AUTH', 'AUTH_REQUIRED']) {
      expect(new RoboApiError('x', { code, status: 401 }).code).toBe(
        'auth_expired',
      );
    }
  });

  it('keeps non-session 401s out of the recovery path', async () => {
    const { RoboApiError } = await importFreshClient();
    expect(
      new RoboApiError('x', { code: 'invalid_credentials', status: 401 }).code,
    ).toBe('invalid_credentials');
    expect(
      new RoboApiError('x', { code: 'ACCOUNT_DISABLED', status: 401 }).code,
    ).toBe('account_disabled');
  });
});

describe('stale-session recovery', () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem('auth_token', 'stale-jwt');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    setPath('/');
  });

  it('on a protected route: rejects, clears credentials, calls the sessionless logout, navigates to /login', async () => {
    setPath('/onboarding');
    const assignSpy = tryMockAssign();
    const { request } = await importFreshClient();

    await expect(
      request('GET', '/api/v1/roboapply/v2/resumes'),
    ).rejects.toMatchObject({ code: 'auth_expired', status: 401 });

    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/v1/roboapply/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    });
    expect(window.localStorage.getItem('auth_token')).toBeNull();
    if (assignSpy) {
      expect(assignSpy).toHaveBeenCalledWith('/login?next=%2Fonboarding');
    }
  });

  it('fires only once for a burst of parallel 401s', async () => {
    setPath('/onboarding');
    tryMockAssign();
    const { request } = await importFreshClient();

    const results = await Promise.allSettled([
      request('GET', '/api/v1/roboapply/auth/me'),
      request('GET', '/api/v1/roboapply/v2/resumes'),
      request('GET', '/api/v1/roboapply/v2/onboarding/session'),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(1);
  });

  it('does NOT redirect from public pages (landing with a stale cookie just renders logged out)', async () => {
    setPath('/');
    const assignSpy = tryMockAssign();
    const { request } = await importFreshClient();

    await expect(
      request('GET', '/api/v1/roboapply/auth/me'),
    ).rejects.toMatchObject({ code: 'auth_expired' });

    const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(0);
    expect(window.localStorage.getItem('auth_token')).toBe('stale-jwt');
    if (assignSpy) {
      expect(assignSpy).not.toHaveBeenCalled();
    }
  });
});
