// @vitest-environment node
//
// Where a payment provider is told to call back, and where the buyer returns
// (MARKET_STRATEGY §5.3 G8; requirement AL-3). The Alipay notify origin for
// GoApply is its own host: an explicit override, else CN_BACKEND_URL, else
// https://www.goapply.top. It never reads BACKEND_URL and never lands on
// another brand's host.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrand } from '../brand/registry.js';
import {
  ALIPAY_NOTIFY_ORIGIN_ENV,
  alipayNotifyOrigin,
  appOrigin,
  callbackOrigin,
  originHost,
  resetAlipayNotifyOriginLogForTests,
  resolveAlipayNotifyOrigin,
  safeReturnPath,
  withQueryParam,
} from './origins.js';

const go = getBrand('goapply');
const ra = getBrand('roboapply');
const silent = { warn: vi.fn() };

beforeEach(() => {
  resetAlipayNotifyOriginLogForTests();
  silent.warn.mockClear();
});

describe('alipayNotifyOrigin: GoApply', () => {
  it('with an empty environment the notify host is www.goapply.top', () => {
    expect(alipayNotifyOrigin(go, {}, silent)).toBe('https://www.goapply.top');
    expect(resolveAlipayNotifyOrigin(go, {})).toEqual({ origin: 'https://www.goapply.top', source: 'canonical', ignoredOverride: null });
    expect(originHost(alipayNotifyOrigin(go, {}, silent))).toBe('www.goapply.top');
    expect(silent.warn).not.toHaveBeenCalled();
  });

  // The precedence: CN_ALIPAY_NOTIFY_ORIGIN, then CN_BACKEND_URL, then the brand's canonical origin.
  it.each([
    ['nothing set', {}, 'https://www.goapply.top', 'canonical'],
    ['CN_BACKEND_URL', { CN_BACKEND_URL: 'https://api.goapply.example' }, 'https://api.goapply.example', 'CN_BACKEND_URL'],
    ['CN_BACKEND_URL with a trailing slash (no double slash later)', { CN_BACKEND_URL: 'https://api.goapply.example/' }, 'https://api.goapply.example', 'CN_BACKEND_URL'],
    ['CN_BACKEND_URL with blanks around it', { CN_BACKEND_URL: '  https://api.goapply.example  ' }, 'https://api.goapply.example', 'CN_BACKEND_URL'],
    ['the override alone', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' }, 'https://pay.goapply.example', 'CN_ALIPAY_NOTIFY_ORIGIN'],
    [
      'the override wins over CN_BACKEND_URL',
      { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' },
      'https://pay.goapply.example',
      'CN_ALIPAY_NOTIFY_ORIGIN',
    ],
    ['the override with a trailing slash', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example/' }, 'https://pay.goapply.example', 'CN_ALIPAY_NOTIFY_ORIGIN'],
    ['the override with a port', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example:8443' }, 'https://pay.goapply.example:8443', 'CN_ALIPAY_NOTIFY_ORIGIN'],
    ['the override in capitals', { CN_ALIPAY_NOTIFY_ORIGIN: 'HTTPS://Pay.GoApply.Example' }, 'https://pay.goapply.example', 'CN_ALIPAY_NOTIFY_ORIGIN'],
    ['a blank override is unset', { CN_ALIPAY_NOTIFY_ORIGIN: '   ', CN_BACKEND_URL: 'https://api.goapply.example' }, 'https://api.goapply.example', 'CN_BACKEND_URL'],
    // The operator may point it at roboapply.io once that host runs this code on the same database: explicit, never a default.
    ['the override names another host on purpose', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://www.roboapply.io' }, 'https://www.roboapply.io', 'CN_ALIPAY_NOTIFY_ORIGIN'],
  ] as const)('%s', (_name, env, origin, source) => {
    expect(resolveAlipayNotifyOrigin(go, env)).toEqual({ origin, source, ignoredOverride: null });
    expect(alipayNotifyOrigin(go, env, silent)).toBe(origin);
    expect(origin.endsWith('/')).toBe(false);
    expect(silent.warn).not.toHaveBeenCalled();
  });

  it('never falls back to BACKEND_URL or to another brand\'s host', () => {
    const international = {
      BACKEND_URL: 'https://www.roboapply.io',
      NEXT_PUBLIC_ROBOAPPLY_URL: 'https://www.roboapply.io',
      ROBOAPPLY_URL: 'https://www.roboapply.io',
      CANONICAL_ORIGIN: 'https://www.roboapply.io',
      ALIPAY_NOTIFY_ORIGIN: 'https://www.roboapply.io',
    };
    expect(alipayNotifyOrigin(go, international, silent)).toBe('https://www.goapply.top');
    expect(resolveAlipayNotifyOrigin(go, international).source).toBe('canonical');
    // BACKEND_URL alone changes nothing; CN_BACKEND_URL next to it is the one that is read.
    expect(alipayNotifyOrigin(go, { BACKEND_URL: 'https://www.roboapply.io' }, silent)).toBe('https://www.goapply.top');
    expect(alipayNotifyOrigin(go, { ...international, CN_BACKEND_URL: 'https://api.goapply.example' }, silent)).toBe('https://api.goapply.example');
    // The notify origin is the API's, not the web app's: CN_CANONICAL_ORIGIN moves the return URL only.
    expect(alipayNotifyOrigin(go, { CN_CANONICAL_ORIGIN: 'https://app.goapply.example' }, silent)).toBe('https://www.goapply.top');
    expect(appOrigin(go, { CN_CANONICAL_ORIGIN: 'https://app.goapply.example' })).toBe('https://app.goapply.example');
  });

  it.each([
    ['http, not https', 'http://www.goapply.top', 'not_https'],
    ['another scheme', 'ftp://www.goapply.top', 'not_https'],
    ['a bare host', 'www.goapply.top', 'malformed'],
    ['not a URL', 'not a url', 'malformed'],
    ['a scheme with no host', 'https://', 'malformed'],
    ['a path', 'https://www.goapply.top/api/v1', 'not_an_origin'],
    ['a whole notify URL, secret included', 'https://www.goapply.top/api/v1/roboapply/billing/alipay/callback?cb=PASTED-SECRET', 'not_an_origin'],
    ['a query', 'https://www.goapply.top/?cb=PASTED-SECRET', 'not_an_origin'],
    ['a fragment', 'https://www.goapply.top/#x', 'not_an_origin'],
    ['credentials', 'https://user:PASTED-SECRET@www.goapply.top', 'not_an_origin'],
  ] as const)('an override that is not an https origin is ignored and logged: %s', (_name, value, reason) => {
    const log = { warn: vi.fn() };
    // Ignored: the next source decides, with and without CN_BACKEND_URL.
    expect(resolveAlipayNotifyOrigin(go, { CN_ALIPAY_NOTIFY_ORIGIN: value })).toEqual({ origin: 'https://www.goapply.top', source: 'canonical', ignoredOverride: reason });
    expect(alipayNotifyOrigin(go, { CN_ALIPAY_NOTIFY_ORIGIN: value }, log)).toBe('https://www.goapply.top');
    expect(alipayNotifyOrigin(go, { CN_ALIPAY_NOTIFY_ORIGIN: value, CN_BACKEND_URL: 'https://api.goapply.example/' }, log)).toBe('https://api.goapply.example');
    // Logged once per process and value, with the variable and the reason, never the value.
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [tag, message, meta] = log.warn.mock.calls[0]!;
    expect(tag).toBe('RA_BILLING');
    expect(message).toContain(ALIPAY_NOTIFY_ORIGIN_ENV);
    expect(meta).toEqual({ variable: 'CN_ALIPAY_NOTIFY_ORIGIN', reason, usedInstead: 'canonical' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('PASTED-SECRET');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(value);
  });

  it('a logger that throws never stops the origin from being resolved', () => {
    const log = {
      warn: vi.fn(() => {
        throw new Error('log sink down');
      }),
    };
    expect(alipayNotifyOrigin(go, { CN_ALIPAY_NOTIFY_ORIGIN: 'http://x.example' }, log)).toBe('https://www.goapply.top');
  });
});

describe('alipayNotifyOrigin: RoboApply (legacy orders only) is unchanged', () => {
  it.each([
    ['nothing set', {}, 'https://www.roboapply.io', 'canonical'],
    ['BACKEND_URL', { BACKEND_URL: 'https://api.roboapply.example/' }, 'https://api.roboapply.example', 'BACKEND_URL'],
    // GoApply's names are never read for RoboApply, the override included.
    ['only CN_ names set', { CN_BACKEND_URL: 'https://api.goapply.example', CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' }, 'https://www.roboapply.io', 'canonical'],
  ] as const)('%s', (_name, env, origin, source) => {
    expect(alipayNotifyOrigin(ra, env, silent)).toBe(origin);
    expect(alipayNotifyOrigin(ra, env, silent)).toBe(callbackOrigin(ra, env));
    expect(resolveAlipayNotifyOrigin(ra, env)).toEqual({ origin, source, ignoredOverride: null });
    expect(silent.warn).not.toHaveBeenCalled();
  });

  it('an invalid GoApply override is not RoboApply\'s problem: nothing is logged', () => {
    expect(alipayNotifyOrigin(ra, { CN_ALIPAY_NOTIFY_ORIGIN: 'http://x.example' }, silent)).toBe('https://www.roboapply.io');
    expect(silent.warn).not.toHaveBeenCalled();
  });
});

describe('the other origins keep their rules', () => {
  it('callbackOrigin: the brand\'s own BACKEND_URL, else its canonical origin', () => {
    expect(callbackOrigin(go, {})).toBe('https://www.goapply.top');
    expect(callbackOrigin(go, { BACKEND_URL: 'https://www.roboapply.io' })).toBe('https://www.goapply.top');
    expect(callbackOrigin(go, { CN_BACKEND_URL: 'https://api.goapply.example//' })).toBe('https://api.goapply.example');
    // Other callbacks (WeChat Pay) do not read the Alipay override.
    expect(callbackOrigin(go, { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' })).toBe('https://www.goapply.top');
    expect(callbackOrigin(ra, {})).toBe('https://www.roboapply.io');
    expect(callbackOrigin(ra, { BACKEND_URL: 'https://api.roboapply.example/' })).toBe('https://api.roboapply.example');
  });

  it('appOrigin: where the buyer returns', () => {
    expect(appOrigin(go, {})).toBe('https://www.goapply.top');
    expect(appOrigin(go, { NEXT_PUBLIC_ROBOAPPLY_URL: 'https://www.roboapply.io', CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' })).toBe('https://www.goapply.top');
    expect(appOrigin(ra, { NEXT_PUBLIC_ROBOAPPLY_URL: 'https://app.example.test/' })).toBe('https://app.example.test');
    expect(appOrigin(ra, {})).toBe('https://www.roboapply.io');
  });

  it('originHost: the host with its port, or null', () => {
    expect(originHost('https://www.goapply.top')).toBe('www.goapply.top');
    expect(originHost('https://pay.goapply.example:8443')).toBe('pay.goapply.example:8443');
    expect(originHost('not a url')).toBeNull();
  });

  it('safeReturnPath and withQueryParam', () => {
    expect(safeReturnPath('/settings/billing')).toBe('/settings/billing');
    for (const bad of ['//evil.example', 'https://evil.example', '/a\\b', 'settings', 7, null]) expect(safeReturnPath(bad)).toBeUndefined();
    expect(withQueryParam('/a', 'billing', 'success')).toBe('/a?billing=success');
    expect(withQueryParam('/a?x=1', 'billing', 'success')).toBe('/a?x=1&billing=success');
  });
});
