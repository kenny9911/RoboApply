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
// Before it clears the dead session it runs the registered session cleanups
// (INT-12; wave-4 carry-over WP-93 #7): the app shell registers "forget the
// push device, clear unsent resume-builder drafts" (components/v3/shell/
// signOutCleanup.ts). `lib` never imports that code — it only runs what was
// registered — and a cleanup that throws, rejects or hangs never blocks the
// recovery.
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

// `init` is unused by the mock body but must stay in the signature: vi.fn()
// derives the recorded `mock.calls` tuple from it, and the logout assertions
// below read calls[0][1] to prove the POST carried keepalive + credentials.
function makeFetchMock() {
  return vi.fn(async (url: string, init?: RequestInit) =>
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

  it('keeps the brand codes (session from / account of the other brand)', async () => {
    const { RoboApiError } = await importFreshClient();
    expect(new RoboApiError('x', { code: 'auth_other_brand', status: 401 }).code).toBe('auth_other_brand');
    expect(new RoboApiError('x', { code: 'account_other_brand', status: 409 }).code).toBe('account_other_brand');
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
    setPath('/jobs');
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
      expect(assignSpy).toHaveBeenCalledWith('/login?next=%2Fjobs');
    }
  });

  it('an other-brand session (401 auth_other_brand) gets the same recovery', async () => {
    setPath('/jobs');
    const assignSpy = tryMockAssign();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/auth/logout')
        ? NO_CONTENT_RESPONSE
        : {
            ok: false,
            status: 401,
            json: async () => ({ success: false, error: 'This session belongs to another site.', code: 'auth_other_brand' }),
          },
    );
    const { request } = await importFreshClient();

    await expect(request('GET', '/api/v1/roboapply/auth/me')).rejects.toMatchObject({ code: 'auth_other_brand', status: 401 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/logout'))).toHaveLength(1);
    expect(window.localStorage.getItem('auth_token')).toBeNull();
    if (assignSpy) expect(assignSpy).toHaveBeenCalledWith('/login?next=%2Fjobs');
  });

  it('fires only once for a burst of parallel 401s', async () => {
    setPath('/jobs');
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

describe('session cleanups run before the dead session is cleared', () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;
  const logoutCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/logout'));

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem('auth_token', 'stale-jwt');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock('../../hooks/pwa');
    vi.doUnmock('../../hooks/resume/useResumePhoto');
    window.localStorage.clear();
    setPath('/');
  });

  it('order: push forget, then builder drafts, then the logout that clears the cookie', async () => {
    setPath('/jobs');
    const assignSpy = tryMockAssign();
    const steps: string[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/logout')) {
        steps.push('logout');
        return NO_CONTENT_RESPONSE;
      }
      return INVALID_TOKEN_RESPONSE;
    });
    const { request, registerSessionCleanup } = await importFreshClient();
    registerSessionCleanup(async () => {
      await new Promise((r) => setTimeout(r, 10)); // like the real push step: asynchronous
      steps.push('push-forget');
      steps.push('clear-drafts');
    });

    await expect(request('GET', '/api/v1/roboapply/v2/resumes')).rejects.toMatchObject({ code: 'auth_expired' });
    // The request is rejected at once; the session is NOT cleared yet.
    expect(logoutCalls()).toHaveLength(0);
    expect(window.localStorage.getItem('auth_token')).toBe('stale-jwt');

    await vi.waitFor(() => expect(logoutCalls()).toHaveLength(1));
    expect(steps).toEqual(['push-forget', 'clear-drafts', 'logout']);
    expect(window.localStorage.getItem('auth_token')).toBeNull();
    if (assignSpy) expect(assignSpy).toHaveBeenCalledWith('/login?next=%2Fjobs');
  });

  it('the shell’s registered cleanup is the push forget followed by the builder-draft clear (no lib → components import)', async () => {
    setPath('/jobs');
    tryMockAssign();
    const steps: string[] = [];
    vi.resetModules();
    vi.doMock('../../hooks/pwa', () => ({
      forgetPushDeviceOnSignOut: async () => {
        await new Promise((r) => setTimeout(r, 5));
        steps.push('push-forget');
      },
    }));
    vi.doMock('../../hooks/resume/useResumePhoto', () => ({
      clearResumeBuilderDeviceData: (options?: { resumePhotos?: boolean }) => {
        steps.push(options?.resumePhotos ? 'clear-drafts+photos' : 'clear-drafts');
      },
    }));
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/logout')) {
        steps.push('logout');
        return NO_CONTENT_RESPONSE;
      }
      return INVALID_TOKEN_RESPONSE;
    });
    const client = await import('../../lib/api/client');
    const { cleanUpDeviceOnSignOut } = await import('../../components/v3/shell/signOutCleanup');
    // What AppShell does on mount (useSessionCleanupRegistration).
    const unregister = client.registerSessionCleanup(cleanUpDeviceOnSignOut);

    await expect(client.request('GET', '/api/v1/roboapply/auth/me')).rejects.toMatchObject({ code: 'auth_expired' });
    await vi.waitFor(() => expect(logoutCalls()).toHaveLength(1));
    // Both ran on auth_expired, in order, before the cookie was cleared; photos are kept.
    expect(steps).toEqual(['push-forget', 'clear-drafts', 'logout']);
    unregister();
  });

  it('a cleanup that throws or rejects never blocks the recovery, and the others still run', async () => {
    setPath('/jobs');
    const assignSpy = tryMockAssign();
    const { request, registerSessionCleanup } = await importFreshClient();
    const ran = vi.fn();
    registerSessionCleanup(() => {
      throw new Error('sync failure');
    });
    registerSessionCleanup(async () => {
      throw new Error('async failure');
    });
    registerSessionCleanup(ran);

    await expect(request('GET', '/api/v1/roboapply/v2/resumes')).rejects.toMatchObject({ code: 'auth_expired' });
    await vi.waitFor(() => expect(logoutCalls()).toHaveLength(1));
    expect(ran).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('auth_token')).toBeNull();
    if (assignSpy) expect(assignSpy).toHaveBeenCalledWith('/login?next=%2Fjobs');
  });

  it('a cleanup that never settles is given SESSION_CLEANUP_TIMEOUT_MS, then the session is cleared anyway', async () => {
    setPath('/jobs');
    tryMockAssign();
    const { request, registerSessionCleanup, SESSION_CLEANUP_TIMEOUT_MS } = await importFreshClient();
    vi.useFakeTimers();
    registerSessionCleanup(() => new Promise<void>(() => {}));

    await expect(request('GET', '/api/v1/roboapply/v2/resumes')).rejects.toMatchObject({ code: 'auth_expired' });
    await vi.advanceTimersByTimeAsync(SESSION_CLEANUP_TIMEOUT_MS - 1);
    expect(logoutCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(logoutCalls()).toHaveLength(1);
    expect(window.localStorage.getItem('auth_token')).toBeNull();
  });

  it('a cleanup’s own 401 does not start a second recovery; a burst still fires once', async () => {
    setPath('/jobs');
    tryMockAssign();
    const { request, registerSessionCleanup } = await importFreshClient();
    // The real push step makes an authenticated call, which 401s like everything else on a dead session.
    registerSessionCleanup(async () => {
      await request('DELETE', '/api/v1/roboapply/push/subscriptions/x').catch(() => undefined);
    });

    const results = await Promise.allSettled([
      request('GET', '/api/v1/roboapply/auth/me'),
      request('GET', '/api/v1/roboapply/v2/resumes'),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    await vi.waitFor(() => expect(logoutCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(logoutCalls()).toHaveLength(1);
  });

  it('an unregistered cleanup does not run; with none registered the recovery stays synchronous', async () => {
    setPath('/jobs');
    tryMockAssign();
    const { request, registerSessionCleanup, runSessionCleanups } = await importFreshClient();
    const cleanup = vi.fn();
    const unregister = registerSessionCleanup(cleanup);
    unregister();
    await expect(runSessionCleanups()).resolves.toBeUndefined();

    await expect(request('GET', '/api/v1/roboapply/v2/resumes')).rejects.toMatchObject({ code: 'auth_expired' });
    expect(logoutCalls()).toHaveLength(1); // already, without waiting
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('does not run cleanups on public pages (a stale cookie there just renders logged out)', async () => {
    setPath('/');
    tryMockAssign();
    const { request, registerSessionCleanup } = await importFreshClient();
    const cleanup = vi.fn();
    registerSessionCleanup(cleanup);
    await expect(request('GET', '/api/v1/roboapply/auth/me')).rejects.toMatchObject({ code: 'auth_expired' });
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanup).not.toHaveBeenCalled();
    expect(logoutCalls()).toHaveLength(0);
  });
});

describe('lib/api/client.ts keeps its layering', () => {
  it('imports nothing from components/ or hooks/', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'lib/api/client.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => /components\/|hooks\//.test(i))).toEqual([]);
    expect(imports).toEqual(['../config', '../localeConfig', '../proxyPaths']);
  });
});

