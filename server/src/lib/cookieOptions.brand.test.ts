// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClearCookieOptions, buildCookieOptions } from './cookieOptions.js';
import { withRequestContext } from './requestContext.js';

afterEach(() => vi.unstubAllEnvs());

describe('buildCookieOptions per brand (R-03)', () => {
  it('keeps the legacy shape outside a request', () => {
    vi.stubEnv('COOKIE_DOMAIN', '');
    expect(buildCookieOptions({ maxAge: 5 })).toMatchObject({ httpOnly: true, sameSite: 'lax', domain: undefined, maxAge: 5 });
    vi.stubEnv('COOKIE_DOMAIN', '.roboapply.io');
    expect(buildCookieOptions().domain).toBe('.roboapply.io');
  });

  it('reads the brand and host from the request context', () => {
    vi.stubEnv('COOKIE_DOMAIN', '.roboapply.io');
    vi.stubEnv('CN_COOKIE_DOMAIN', '.goapply.top');
    withRequestContext({ requestId: 'r', brandId: 'goapply', host: 'www.goapply.top' }, () => {
      expect(buildCookieOptions({ maxAge: 1 }).domain).toBe('.goapply.top');
      expect(buildClearCookieOptions().domain).toBe('.goapply.top');
    });
    withRequestContext({ requestId: 'r', brandId: 'roboapply', host: 'roboapply-git-x.vercel.app' }, () => {
      expect(buildCookieOptions().domain).toBeUndefined();
      expect(buildClearCookieOptions().domain).toBeUndefined();
    });
  });

  it('accepts a request as the first argument', () => {
    vi.stubEnv('COOKIE_DOMAIN', '.roboapply.io');
    const req = { headers: { host: 'www.roboapply.io' }, brand: { id: 'roboapply' } } as never;
    expect(buildCookieOptions(req, { maxAge: 9 })).toMatchObject({ domain: '.roboapply.io', maxAge: 9, httpOnly: true });
    const preview = { headers: { host: 'x.vercel.app' }, brand: { id: 'roboapply' } } as never;
    expect(buildCookieOptions(preview).domain).toBeUndefined();
  });
});
