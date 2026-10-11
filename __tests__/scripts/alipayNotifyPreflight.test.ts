// @vitest-environment node
//
// scripts/alipay-notify-preflight.mjs (requirement AL-8; MARKET_STRATEGY.md
// section 5.3, cut-over checklist steps 2 and 5; correction C1).
//
// The script answers one question before any Alipay order is created: does the
// host GoApply's notify goes to answer with OUR callback JSON? These tests hold
// three things:
//   1. the host it checks is the host the server would put in `notify_url`
//      (parity with `resolveAlipayNotifyOrigin`, table of environments);
//   2. each outcome is reported as the runbook says, with the exit code;
//   3. the request is the harmless one: one GET, no parameter, no secret.
// No test reaches the network. Outcomes use an injected fetch; the last block
// runs the script against the real billing router on a loopback port, so its
// PASS is tied to what this code really answers.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/src/lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../server/src/test/fakePrisma.js');
  return { default: createFakePrisma({ uniqueFields: { alipayOrder: ['outTradeNo'] } }) };
});
vi.mock('../../server/src/services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// @ts-expect-error: a plain .mjs script, no type declarations
import * as script from '../../scripts/alipay-notify-preflight.mjs';
import { ALIPAY_NOTIFY_ORIGIN_ENV, resolveAlipayNotifyOrigin } from '../../server/src/platform/billing/origins';
import { getBrand } from '../../server/src/platform/brand/registry';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/alipay-notify-preflight.mjs', import.meta.url));
const CALLBACK_PATH = '/api/v1/roboapply/billing/alipay/callback';
const SECRET = 'TEST-CALLBACK-SECRET-do-not-print';

type Env = Record<string, string | undefined>;
type FetchCall = { url: string; init: RequestInit & { headers?: Record<string, string> } };

/** An env that records every name read from it. */
function recordingEnv(values: Env): { env: Env; read: Set<string> } {
  const read = new Set<string>();
  const env = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return Reflect.get(target, key);
    },
  });
  return { env, read };
}

function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

/** Our own answers to a request without parameters, as app.ts sends them (brand header included). */
const OURS = {
  secretSet: () => jsonAnswer(403, { code: 40003, message: 'forbidden' }, { 'x-ra-brand': 'goapply' }),
  secretUnset: () => jsonAnswer(503, { code: 50003, message: 'callback verification unavailable' }, { 'x-ra-brand': 'goapply' }),
};

async function run(argv: string[], options: { env?: Env; answer?: () => Response | Promise<Response>; timeoutMs?: number } = {}) {
  const calls: FetchCall[] = [];
  const lines: string[] = [];
  const fetchStub = vi.fn(async (url: string, init: FetchCall['init']) => {
    calls.push({ url: String(url), init });
    return (options.answer ?? OURS.secretSet)();
  });
  const exitCode: number = await script.main(argv, {
    env: options.env ?? {},
    fetch: fetchStub,
    timeoutMs: options.timeoutMs,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  });
  const output = lines.join('\n');
  const result = lines.find((line) => line.startsWith('result:')) ?? '';
  return { exitCode, calls, output, result };
}

describe('which host is checked', () => {
  it('with an empty environment it checks www.goapply.top', async () => {
    const r = await run([]);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(`https://www.goapply.top${CALLBACK_PATH}`);
    expect(r.output).toContain('host:     www.goapply.top');
    expect(r.output).toContain('decided:  the brand origin (no variable set)');
    expect(r.exitCode).toBe(0);
  });

  it('the precedence: CN_ALIPAY_NOTIFY_ORIGIN, then CN_BACKEND_URL, then the brand origin', async () => {
    const both = { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' };
    const first = await run([], { env: both });
    expect(first.calls[0]!.url).toBe(`https://pay.goapply.example${CALLBACK_PATH}`);
    expect(first.output).toContain('decided:  CN_ALIPAY_NOTIFY_ORIGIN');

    const second = await run([], { env: { CN_BACKEND_URL: 'https://api.goapply.example/' } });
    expect(second.calls[0]!.url).toBe(`https://api.goapply.example${CALLBACK_PATH}`);
    expect(second.output).toContain('decided:  CN_BACKEND_URL');
  });

  it('--origin wins over every variable, in both spellings', async () => {
    const env = { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' };
    for (const argv of [['--origin', 'https://preview.goapply.example'], ['--origin=https://preview.goapply.example/']]) {
      const r = await run(argv, { env });
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.url).toBe(`https://preview.goapply.example${CALLBACK_PATH}`);
      expect(r.output).toContain('host:     preview.goapply.example');
      expect(r.output).toContain('decided:  --origin');
      expect(r.exitCode).toBe(0);
    }
  });

  it('BACKEND_URL is never read, and neither is another brand\'s origin or the callback secret', async () => {
    const international = {
      BACKEND_URL: 'https://www.roboapply.io',
      NEXT_PUBLIC_ROBOAPPLY_URL: 'https://www.roboapply.io',
      ROBOAPPLY_URL: 'https://www.roboapply.io',
      CANONICAL_ORIGIN: 'https://www.roboapply.io',
      ALIPAY_NOTIFY_ORIGIN: 'https://www.roboapply.io',
      ALIPAY_CALLBACK_SECRET: SECRET,
    };
    const { env, read } = recordingEnv(international);
    const r = await run([], { env });
    expect(r.calls[0]!.url).toBe(`https://www.goapply.top${CALLBACK_PATH}`);
    expect([...read].sort()).toEqual(['CN_ALIPAY_NOTIFY_ORIGIN', 'CN_BACKEND_URL']);

    // With --origin too: the environment is looked at for an ignored override only.
    const withArg = recordingEnv(international);
    await run(['--origin', 'https://preview.goapply.example'], { env: withArg.env });
    expect([...withArg.read].every((name) => name === 'CN_ALIPAY_NOTIFY_ORIGIN' || name === 'CN_BACKEND_URL')).toBe(true);
    expect(script.resolveNotifyOrigin(international)).toEqual({ origin: 'https://www.goapply.top', source: 'canonical', ignoredOverride: null });
  });

  // The server's own function for the same environment: origin, source and the ignored-override reason.
  it.each<[string, Env]>([
    ['nothing set', {}],
    ['CN_BACKEND_URL', { CN_BACKEND_URL: 'https://api.goapply.example' }],
    ['CN_BACKEND_URL with a trailing slash', { CN_BACKEND_URL: 'https://api.goapply.example/' }],
    ['CN_BACKEND_URL with several trailing slashes', { CN_BACKEND_URL: 'https://api.goapply.example///' }],
    ['CN_BACKEND_URL with blanks around it', { CN_BACKEND_URL: '  https://api.goapply.example  ' }],
    ['a blank CN_BACKEND_URL', { CN_BACKEND_URL: '   ' }],
    ['CN_BACKEND_URL with a path (used as written)', { CN_BACKEND_URL: 'https://gateway.goapply.example/cn' }],
    ['CN_BACKEND_URL on http (used as written)', { CN_BACKEND_URL: 'http://api.goapply.example' }],
    ['the override alone', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' }],
    ['the override wins over CN_BACKEND_URL', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example', CN_BACKEND_URL: 'https://api.goapply.example' }],
    ['the override with a trailing slash', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example/' }],
    ['the override with a port', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example:8443' }],
    ['the override with the default port', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example:443' }],
    ['the override in capitals', { CN_ALIPAY_NOTIFY_ORIGIN: 'HTTPS://Pay.GoApply.Example' }],
    ['the override with blanks around it', { CN_ALIPAY_NOTIFY_ORIGIN: '  https://pay.goapply.example  ' }],
    ['a blank override', { CN_ALIPAY_NOTIFY_ORIGIN: '   ', CN_BACKEND_URL: 'https://api.goapply.example' }],
    ['an empty override', { CN_ALIPAY_NOTIFY_ORIGIN: '' }],
    ['the override names another brand\'s host on purpose', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://www.roboapply.io' }],
    ['BACKEND_URL alone', { BACKEND_URL: 'https://www.roboapply.io' }],
    ['BACKEND_URL next to CN_BACKEND_URL', { BACKEND_URL: 'https://www.roboapply.io', CN_BACKEND_URL: 'https://api.goapply.example' }],
    ['CN_CANONICAL_ORIGIN moves the web app only', { CN_CANONICAL_ORIGIN: 'https://app.goapply.example' }],
    ['an override on http', { CN_ALIPAY_NOTIFY_ORIGIN: 'http://www.goapply.top' }],
    ['an override on http, with CN_BACKEND_URL', { CN_ALIPAY_NOTIFY_ORIGIN: 'http://www.goapply.top', CN_BACKEND_URL: 'https://api.goapply.example/' }],
    ['an override with another scheme', { CN_ALIPAY_NOTIFY_ORIGIN: 'ftp://www.goapply.top' }],
    ['an override that is a bare host', { CN_ALIPAY_NOTIFY_ORIGIN: 'www.goapply.top' }],
    ['an override that is not a URL', { CN_ALIPAY_NOTIFY_ORIGIN: 'not a url' }],
    ['an override with no host', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://' }],
    ['an override with a path', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://www.goapply.top/api/v1' }],
    ['an override that is the whole notify URL', { CN_ALIPAY_NOTIFY_ORIGIN: `https://www.goapply.top${CALLBACK_PATH}?cb=${SECRET}` }],
    ['an override with a query', { CN_ALIPAY_NOTIFY_ORIGIN: `https://www.goapply.top/?cb=${SECRET}` }],
    ['an override with a fragment', { CN_ALIPAY_NOTIFY_ORIGIN: 'https://www.goapply.top/#x' }],
    ['an override with credentials', { CN_ALIPAY_NOTIFY_ORIGIN: `https://user:${SECRET}@www.goapply.top` }],
  ])('the resolver equals the server\'s for the same environment: %s', (_name, env) => {
    expect(script.resolveNotifyOrigin(env)).toEqual(resolveAlipayNotifyOrigin(getBrand('goapply'), env));
  });

  it('the names and the last step are the server\'s', () => {
    expect(script.NOTIFY_ORIGIN_ENV).toBe(ALIPAY_NOTIFY_ORIGIN_ENV);
    expect(script.GOAPPLY_CANONICAL_ORIGIN).toBe(getBrand('goapply').canonicalOrigin);
    expect(script.PREFLIGHT_TIMEOUT_MS).toBe(10_000);
  });

  it.each<[string, string]>([
    ['malformed', 'pay.goapply.example'],
    ['not_https', 'http://pay.goapply.example'],
    ['not_an_origin', `https://pay.goapply.example${CALLBACK_PATH}?cb=${SECRET}`],
  ])('an ignored CN_ALIPAY_NOTIFY_ORIGIN (%s) is a FAIL: nothing is sent and the value is not printed', async (_reason, value) => {
    const r = await run([], { env: { CN_ALIPAY_NOTIFY_ORIGIN: value, CN_BACKEND_URL: 'https://api.goapply.example' } });
    expect(r.exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.result).toMatch(/^result:\s+FAIL\s/);
    expect(r.output).toContain('CN_ALIPAY_NOTIFY_ORIGIN is set in this shell and the server would ignore it');
    // What the server would use instead is named, by host.
    expect(r.output).toContain('api.goapply.example (CN_BACKEND_URL)');
    const alone = await run([], { env: { CN_ALIPAY_NOTIFY_ORIGIN: value } });
    expect(alone.output).toContain('www.goapply.top (the brand origin)');
    expect(alone.calls).toHaveLength(0);
    expect(alone.exitCode).toBe(1);
    expect(r.output).toContain('Nothing was sent.');
    expect(r.output).not.toContain(SECRET);
    expect(r.output).not.toContain(value);
  });

  // One rule: a run that sees an ignored override never ends in PASS. A deployment that holds the
  // same value sends the notify to the next step of the chain, which --origin does not change.
  it.each<[string, string]>([
    ['malformed', 'pay.goapply.example'],
    ['not_https', 'http://pay.goapply.example'],
    ['not_an_origin', `https://www.goapply.top/?cb=${SECRET}`],
  ])('with --origin an ignored override in the shell (%s) is a FAIL too: the given host is not checked', async (_reason, value) => {
    for (const argv of [['--origin', 'https://preview.goapply.example'], ['--origin=https://preview.goapply.example']]) {
      const r = await run(argv, { env: { CN_ALIPAY_NOTIFY_ORIGIN: value, CN_BACKEND_URL: 'https://api.goapply.example' } });
      expect(r.exitCode).toBe(1);
      expect(r.calls).toHaveLength(0);
      expect(r.result).toMatch(/^result:\s+FAIL\s+CN_ALIPAY_NOTIFY_ORIGIN is set in this shell and the server would ignore it/);
      expect(r.output).toContain('sends the notify to api.goapply.example (CN_BACKEND_URL)');
      expect(r.output).toContain('--origin does not change that, so the host you gave was not checked');
      expect(r.output).toContain('unset it in this shell');
      expect(r.output).toContain('Nothing was sent.');
      expect(r.output).not.toMatch(/result:\s+PASS/);
      expect(r.output).not.toContain(SECRET);
      expect(r.output).not.toContain(value);
    }
  });

  it('no environment with an ignored override can end in PASS, whatever the host answers', async () => {
    for (const value of ['www.goapply.top', 'http://www.goapply.top', 'https://www.goapply.top/api', 'ftp://x', 'https://']) {
      for (const argv of [[], ['--origin', 'https://www.goapply.top'], ['--origin', 'http://127.0.0.1:8787']]) {
        const r = await run(argv, { env: { CN_ALIPAY_NOTIFY_ORIGIN: value }, answer: OURS.secretSet });
        expect(r.exitCode).toBe(1);
        expect(r.calls).toHaveLength(0);
      }
    }
  });

  it('a usage error in --origin is reported first, ignored override or not', async () => {
    const r = await run(['--origin', 'www.goapply.top'], { env: { CN_ALIPAY_NOTIFY_ORIGIN: 'not a url' } });
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
  });

  it('a usable override in the shell does not stand in the way of --origin', async () => {
    const r = await run(['--origin', 'https://preview.goapply.example'], { env: { CN_ALIPAY_NOTIFY_ORIGIN: 'https://pay.goapply.example' } });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(`https://preview.goapply.example${CALLBACK_PATH}`);
    expect(r.exitCode).toBe(0);
  });

  it.each<[string, Env]>([
    ['a bare host', { CN_BACKEND_URL: 'api.goapply.example' }],
    ['a query', { CN_BACKEND_URL: `https://api.goapply.example/?cb=${SECRET}` }],
    ['credentials', { CN_BACKEND_URL: `https://user:${SECRET}@api.goapply.example` }],
  ])('a CN_BACKEND_URL the worker could not call (%s) is a FAIL without a request', async (_name, env) => {
    const r = await run([], { env });
    expect(r.exitCode).toBe(1);
    expect(r.calls).toHaveLength(0);
    expect(r.result).toMatch(/^result:\s+FAIL\s+CN_BACKEND_URL is not/);
    expect(r.output).not.toContain(SECRET);
  });
});

describe('arguments', () => {
  it.each<[string, string[]]>([
    ['a pasted notify URL, secret included', ['--origin', `https://www.goapply.top${CALLBACK_PATH}?cb=${SECRET}`]],
    ['a path', ['--origin', 'https://www.goapply.top/api']],
    ['credentials', ['--origin', `https://user:${SECRET}@www.goapply.top`]],
    ['http on a public host', ['--origin', 'http://www.goapply.top']],
    ['another scheme', ['--origin', 'ftp://www.goapply.top']],
    ['a bare host', ['--origin', 'www.goapply.top']],
    ['no value', ['--origin']],
    ['an empty value', ['--origin=']],
    ['an unknown flag', [`--secret=${SECRET}`]],
    ['a stray word', [`https://www.goapply.top/?cb=${SECRET}`]],
  ])('a usage error exits 2, sends nothing and never repeats the value: %s', async (_name, argv) => {
    const r = await run(argv);
    expect(r.exitCode).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(r.output).toContain('usage: node scripts/alipay-notify-preflight.mjs [--origin https://…]');
    expect(r.output).not.toContain(SECRET);
  });

  it('http is accepted for a loopback host, so the runbook can try it on a local stub', async () => {
    for (const origin of ['http://localhost:4621', 'http://127.0.0.1:8787', 'http://goapply.localhost:4621']) {
      const r = await run(['--origin', origin]);
      expect(r.calls[0]!.url).toBe(`${origin}${CALLBACK_PATH}`);
      expect(r.exitCode).toBe(0);
    }
  });

  it('--help prints the usage line and sends nothing', async () => {
    const r = await run(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.output).toContain(script.USAGE);
  });

  it('the usage line is in the script header', () => {
    const head = readFileSync(SCRIPT_PATH, 'utf8').split('\n').slice(0, 12).join('\n');
    expect(head).toContain('//   node scripts/alipay-notify-preflight.mjs [--origin https://…]');
    expect(script.USAGE).toBe('usage: node scripts/alipay-notify-preflight.mjs [--origin https://…]');
  });
});

describe('the request', () => {
  it('is one GET to the callback path with no parameter, no body, no secret and no followed redirect', async () => {
    const { env, read } = recordingEnv({ ALIPAY_CALLBACK_SECRET: SECRET, CN_BACKEND_URL: 'https://api.goapply.example' });
    const r = await run([], { env });
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0]!;
    const sent = new URL(url);
    expect(sent.pathname).toBe(CALLBACK_PATH);
    expect(sent.search).toBe('');
    expect(sent.hash).toBe('');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headerNames = Object.keys(init.headers ?? {}).map((name) => name.toLowerCase());
    expect(headerNames.sort()).toEqual(['accept', 'user-agent']);
    // No order number, no status, no secret: anywhere.
    const everything = JSON.stringify({ url, headers: init.headers }) + r.output;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toMatch(/out_trade_no|pay_status|total_amount|[?&]cb=/);
    expect(read.has('ALIPAY_CALLBACK_SECRET')).toBe(false);
  });

  it('prints the host, the HTTP status and one result line', async () => {
    const r = await run(['--origin', 'https://preview.goapply.example']);
    expect(r.output.split('\n')).toEqual([
      'Alipay notify pre-flight (read-only: one GET, no parameters, no secret, no order)',
      'host:     preview.goapply.example',
      'decided:  --origin',
      `request:  GET https://preview.goapply.example${CALLBACK_PATH}`,
      'status:   HTTP 403',
      'answer:   { code: 40003 }',
      'brand:    goapply (X-RA-Brand)',
      'result:   PASS  our callback route answered (403 / 40003, the refusal of a request without the secret) and a callback secret is set on that host.',
      `          ${script.NOT_PROVEN}`,
    ]);
  });

  it('a PASS says what one request cannot prove; no other result prints that line', async () => {
    expect(script.NOT_PROVEN).toContain('the same database and the same callback secret');
    expect((await run([])).output).toContain(script.NOT_PROVEN);
    expect((await run([], { answer: OURS.secretUnset })).output).not.toContain(script.NOT_PROVEN);
    expect((await run([], { answer: () => new Response('Not Found', { status: 404 }) })).output).not.toContain(script.NOT_PROVEN);
  });

  it('a host read from the shell is to be compared with the deployment\'s boot line', async () => {
    const r = await run([]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('GoApply Alipay notify host: <host>');
  });
});

describe('each outcome', () => {
  it('403 / 40003 with the brand header is PASS, exit 0', async () => {
    const r = await run([], { answer: OURS.secretSet });
    expect(r.result).toMatch(/^result:\s+PASS\s+our callback route answered/);
    expect(r.exitCode).toBe(0);
  });

  it('503 / 50003 reports that the route is reached and the secret is missing', async () => {
    const r = await run([], { answer: OURS.secretUnset });
    expect(r.result).toMatch(/^result:\s+PASS-ROUTE \/ FAIL-SECRET\s/);
    expect(r.result).toContain('the callback route is reached');
    expect(r.result).toContain('ALIPAY_CALLBACK_SECRET is not set on that host');
    expect(r.output).toContain('status:   HTTP 503');
    expect(r.exitCode).toBe(1);
  });

  // This code asks for the secret before it looks at the parameters, so 40001 is never its
  // answer to this request. It is the older production handler's, when no secret is set there.
  it('400 / 40001 is the older handler without a secret: the route answers, the result is not PASS', async () => {
    const r = await run([], { answer: () => jsonAnswer(400, { code: 40001, message: 'invalid callback params' }) });
    expect(r.result).toMatch(/^result:\s+PASS-ROUTE \/ FAIL-HANDLER\s/);
    expect(r.result).toContain('NO callback secret is set on its host');
    expect(r.exitCode).toBe(1);
  });

  it('403 / 40003 without the brand header is the older handler with a secret: not PASS', async () => {
    const r = await run([], { answer: () => jsonAnswer(403, { code: 40003, message: 'forbidden' }) });
    expect(r.result).toMatch(/^result:\s+PASS-ROUTE \/ FAIL-HANDLER\s/);
    expect(r.result).toContain('without the X-RA-Brand header');
    expect(r.output).toContain('brand:    no X-RA-Brand header');
    expect(r.exitCode).toBe(1);
  });

  it('a 401 is FAIL: deployment protection', async () => {
    const r = await run([], { answer: () => new Response('Authentication Required', { status: 401, headers: { 'content-type': 'text/html' } }) });
    expect(r.result).toMatch(/^result:\s+FAIL\s+HTTP 401/);
    expect(r.result).toContain('Deployment Protection');
    expect(r.exitCode).toBe(1);
  });

  it('a 404 is FAIL: the host does not serve the route', async () => {
    const r = await run([], { answer: () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }) });
    expect(r.result).toMatch(/^result:\s+FAIL\s+HTTP 404: this host does not serve the callback route/);
    expect(r.exitCode).toBe(1);
  });

  it('a 404 brand_unavailable is FAIL and names the deployment scope', async () => {
    const r = await run([], { answer: () => jsonAnswer(404, { success: false, code: 'brand_unavailable', error: 'This site is not served by this deployment.' }) });
    expect(r.result).toMatch(/^result:\s+FAIL\s+HTTP 404 brand_unavailable/);
    expect(r.result).toContain('ALLOWED_BRANDS');
    expect(r.exitCode).toBe(1);
  });

  it.each<[string, number, string]>([
    ['a page by its content type', 200, 'text/html; charset=utf-8'],
    ['a page served as plain text', 200, 'text/plain'],
    ['an error page of a gateway', 502, 'text/html'],
  ])('an HTML body is FAIL: %s', async (_name, status, contentType) => {
    const r = await run([], { answer: () => new Response('<!DOCTYPE html><html><body>GoApply</body></html>', { status, headers: { 'content-type': contentType } }) });
    expect(r.result).toMatch(new RegExp(`^result:\\s+FAIL\\s+HTTP ${status} with an HTML page, not our JSON`));
    expect(r.exitCode).toBe(1);
  });

  it('a redirect to another host is FAIL, with the host and the path but never the query', async () => {
    const r = await run([], {
      answer: () => new Response(null, { status: 308, headers: { location: `https://www.roboapply.io${CALLBACK_PATH}?cb=${SECRET}` } }),
    });
    expect(r.result).toMatch(/^result:\s+FAIL\s+a redirect \(HTTP 308\) to another host: www\.roboapply\.io\/api\/v1\/roboapply\/billing\/alipay\/callback\./);
    expect(r.output).not.toContain(SECRET);
    expect(r.calls).toHaveLength(1);
    expect(r.exitCode).toBe(1);
  });

  it('a redirect on the same host is FAIL too: the worker posts to the exact address', async () => {
    const r = await run([], { answer: () => new Response(null, { status: 301, headers: { location: '/zh/login' } }) });
    expect(r.result).toMatch(/^result:\s+FAIL\s+a redirect \(HTTP 301\) to another address on the same host: www\.goapply\.top\/zh\/login\./);
    expect(r.exitCode).toBe(1);
  });

  it('a redirect that was followed anyway is still FAIL', async () => {
    const followed = OURS.secretSet();
    Object.defineProperty(followed, 'url', { value: `https://www.roboapply.io${CALLBACK_PATH}` });
    Object.defineProperty(followed, 'redirected', { value: true });
    const r = await run([], { answer: () => followed });
    expect(r.result).toMatch(/^result:\s+FAIL\s+a redirect .* to another host: www\.roboapply\.io/);
    expect(r.exitCode).toBe(1);
  });

  it('no answer within the limit is FAIL: timeout', async () => {
    const calls: FetchCall[] = [];
    const lines: string[] = [];
    const never = (url: string, init: FetchCall['init']) =>
      new Promise<Response>((_resolve, reject) => {
        calls.push({ url, init });
        init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    const exitCode = await script.main([], { env: {}, fetch: never, timeoutMs: 20, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
    expect(calls).toHaveLength(1);
    expect(lines.join('\n')).toContain('status:   no answer');
    expect(lines.at(-1)).toMatch(/^result:\s+FAIL\s+no answer within .* \(timeout\)\./);
    expect(exitCode).toBe(1);
  });

  it('the default limit is ten seconds', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const never = (_url: string, init: FetchCall['init']) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
        });
      const pending: Promise<number> = script.main([], { env: {}, fetch: never, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(lines.some((line) => line.startsWith('result:'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(1);
      expect(lines.at(-1)).toContain('no answer within 10 s (timeout)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a body that stops arriving is a timeout as well', async () => {
    const stalled = (_url: string, init: FetchCall['init']) =>
      Promise.resolve({
        status: 403,
        headers: new Headers({ 'content-type': 'application/json' }),
        url: '',
        redirected: false,
        type: 'basic',
        text: () => new Promise<string>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      });
    const lines: string[] = [];
    const exitCode = await script.main([], { env: {}, fetch: stalled, timeoutMs: 20, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
    expect(lines.at(-1)).toMatch(/^result:\s+FAIL\s+no answer within/);
    expect(exitCode).toBe(1);
  });

  it('a host that cannot be reached is FAIL, with the error code and nothing else', async () => {
    const lines: string[] = [];
    const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const exitCode = await script.main([], { env: {}, fetch: refused, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
    expect(lines.at(-1)).toMatch(/^result:\s+FAIL\s+the request failed before any answer \(ENOTFOUND\)/);
    expect(exitCode).toBe(1);
  });

  it.each<[string, () => Response]>([
    ['a success answer to a request that proves nothing', () => jsonAnswer(200, { code: 0, message: 'success' }, { 'x-ra-brand': 'goapply' })],
    ['our code with another status', () => jsonAnswer(200, { code: 40003 }, { 'x-ra-brand': 'goapply' })],
    ['our status with another code', () => jsonAnswer(403, { code: 'AUTH_REQUIRED' }, { 'x-ra-brand': 'goapply' })],
    ['an exception in the handler', () => jsonAnswer(500, { code: 50001, message: 'internal error' }, { 'x-ra-brand': 'goapply' })],
    ['a JSON array', () => jsonAnswer(403, [40003])],
    ['text that is not JSON', () => new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } })],
  ])('anything else is FAIL: %s', async (_name, answer) => {
    const r = await run([], { answer });
    expect(r.result).toMatch(/^result:\s+FAIL\s/);
    expect(r.exitCode).toBe(1);
  });

  it('exit code 0 only on PASS', () => {
    const answers = [
      { status: 403, body: '{"code":40003}', brandHeader: 'goapply' },
      { status: 403, body: '{"code":40003}', brandHeader: null },
      { status: 503, body: '{"code":50003}', brandHeader: 'goapply' },
      { status: 400, body: '{"code":40001}', brandHeader: 'goapply' },
      { status: 401, body: '', brandHeader: null },
      { status: 404, body: '', brandHeader: null },
      { status: 200, body: '<html></html>', brandHeader: null },
      { status: 302, body: '', brandHeader: null, location: 'https://elsewhere.example/' },
    ];
    const results = answers.map((answer) => script.classifyAnswer({ ...answer, requestUrl: `https://www.goapply.top${CALLBACK_PATH}` }));
    expect(results.map((r) => [r.verdict, r.exitCode])).toEqual([
      ['PASS', 0],
      ['PASS-ROUTE / FAIL-HANDLER', 1],
      ['PASS-ROUTE / FAIL-SECRET', 1],
      ['PASS-ROUTE / FAIL-HANDLER', 1],
      ['FAIL', 1],
      ['FAIL', 1],
      ['FAIL', 1],
      ['FAIL', 1],
    ]);
  });
});

describe('run as a command', () => {
  // A bare environment: the child sees none of this shell's variables (no notify origin, no secret).
  const bareEnv = { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv;
  const node = (args: string[]) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', env: bareEnv, timeout: 20_000 });

  it('--help exits 0 with the usage line', () => {
    const r = node(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('usage: node scripts/alipay-notify-preflight.mjs [--origin https://…]');
  });

  it('a usage error exits 2 before anything is sent', () => {
    const r = node(['--origin', `https://www.goapply.top${CALLBACK_PATH}?cb=${SECRET}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--origin: it is not a bare origin');
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it('an ignored override in the shell exits 1 with --origin, and nothing is sent', () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--origin', 'http://127.0.0.1:9'], {
      encoding: 'utf8',
      env: { ...bareEnv, CN_ALIPAY_NOTIFY_ORIGIN: `https://www.goapply.top${CALLBACK_PATH}?cb=${SECRET}` },
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/result:\s+FAIL\s+CN_ALIPAY_NOTIFY_ORIGIN is set in this shell/);
    expect(r.stdout).toContain('Nothing was sent.');
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  // Node resolves the entry module through symbolic links and leaves argv[1] as typed. On macOS
  // every path under /tmp and /var is one; a linked checkout or scripts directory is another.
  // The command must run all the same: silence with exit 0 would read as a pass.
  describe('started through a symbolic link', () => {
    let dir: string;
    let fileLink: string;
    let dirLink: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'alipay-preflight-link-'));
      fileLink = path.join(dir, 'preflight-link.mjs');
      symlinkSync(SCRIPT_PATH, fileLink);
      symlinkSync(path.dirname(SCRIPT_PATH), path.join(dir, 'scripts-link'), 'dir');
      dirLink = path.join(dir, 'scripts-link', path.basename(SCRIPT_PATH));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const viaLink = (link: string, args: string[]) => spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', env: bareEnv, timeout: 20_000 });

    it.each<[string, () => string]>([
      ['a link to the file', () => fileLink],
      ['a link to the scripts directory', () => dirLink],
    ])('a usage error still exits 2 with the usage line on stderr: %s', (_name, link) => {
      const r = viaLink(link(), ['--bogus']);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(script.USAGE);
      expect(r.stdout).toBe('');
    });

    it.each<[string, () => string]>([
      ['a link to the file', () => fileLink],
      ['a link to the scripts directory', () => dirLink],
    ])('--help still prints the usage line on stdout: %s', (_name, link) => {
      const r = viaLink(link(), ['--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(script.USAGE);
    });

    it('a host that does not answer is still a FAIL with exit 1, never silence', () => {
      // Port 9 (discard) on loopback: nothing listens; no network is reached.
      const r = viaLink(dirLink, ['--origin', 'http://127.0.0.1:9']);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/result:\s+FAIL\s+the request failed before any answer/);
    });

    it('the entry check compares real paths, and says no for another file or none', () => {
      const moduleUrl = pathToFileURL(SCRIPT_PATH).href;
      expect(script.isEntryPoint(SCRIPT_PATH, moduleUrl)).toBe(true);
      expect(script.isEntryPoint(fileLink, moduleUrl)).toBe(true);
      expect(script.isEntryPoint(dirLink, moduleUrl)).toBe(true);
      // Started with --preserve-symlinks-main the module URL is the link itself.
      expect(script.isEntryPoint(SCRIPT_PATH, pathToFileURL(fileLink).href)).toBe(true);
      expect(script.isEntryPoint(fileURLToPath(import.meta.url), moduleUrl)).toBe(false);
      expect(script.isEntryPoint(path.join(dir, 'missing.mjs'), moduleUrl)).toBe(false);
      expect(script.isEntryPoint(undefined, moduleUrl)).toBe(false);
      expect(script.isEntryPoint('', moduleUrl)).toBe(false);
    });

    it('importing the script does not run it', () => {
      // This test file imported it at the top: had it run, vitest's own argv would have been a usage error.
      expect(script.isEntryPoint()).toBe(false);
    });
  });
});

// The script against the real route. `handleAlipayCallback`, the billing router and the brand
// middleware are the server's own; the request is the script's own (the real fetch, on a
// loopback port). A request without parameters never opens the database (rule A6).
describe('against the real callback route (loopback)', () => {
  type Harness = { baseUrl: string; close(): Promise<void> };
  let harness: Harness;
  let callbackPath: string;
  let fakeDb: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const { startRouteHarness } = await import('../../server/src/test/routeHarness.js');
    const billing = await import('../../server/src/roboapply/routes/billing.js');
    const rails = await import('../../server/src/platform/billing/rails/alipayWorker.js');
    fakeDb = (await import('../../server/src/lib/prisma.js')).default as unknown as typeof fakeDb;
    callbackPath = rails.ALIPAY_CALLBACK_PATH;
    harness = await startRouteHarness({ mounts: [['/api/v1/roboapply/billing', billing.default]], env: {} });
  });
  afterAll(async () => {
    await harness?.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function runReal(env: Env) {
    for (const name of ['ALIPAY_CALLBACK_SECRET', 'ALIPAY_SECRETLESS_UNTIL', 'CN_PAYMENTS_ENABLED']) vi.stubEnv(name, env[name] ?? '');
    const lines: string[] = [];
    const exitCode: number = await script.main(['--origin', harness.baseUrl], { env: {}, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) });
    return { exitCode, output: lines.join('\n'), result: lines.find((line) => line.startsWith('result:')) ?? '' };
  }

  it('the path is the one the rail puts in notify_url', () => {
    expect(script.ALIPAY_CALLBACK_PATH).toBe(callbackPath);
  });

  it('with a callback secret set, this code answers 403 / 40003 and the script reports PASS', async () => {
    const findUnique = vi.spyOn(fakeDb.alipayOrder as { findUnique: (...args: unknown[]) => unknown }, 'findUnique');
    const r = await runReal({ ALIPAY_CALLBACK_SECRET: SECRET });
    expect(r.output).toContain('status:   HTTP 403');
    expect(r.output).toContain('answer:   { code: 40003 }');
    expect(r.output).toMatch(/brand:\s+(goapply|roboapply) \(X-RA-Brand\)/);
    expect(r.result).toMatch(/^result:\s+PASS\s+our callback route answered/);
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain(SECRET);
    // Read-only in the strict sense: the order table was not even read.
    expect(findUnique).not.toHaveBeenCalled();
    findUnique.mockRestore();
  });

  it('the kill switch does not close the route: still PASS with CN_PAYMENTS_ENABLED=false', async () => {
    const r = await runReal({ ALIPAY_CALLBACK_SECRET: SECRET, CN_PAYMENTS_ENABLED: 'false' });
    expect(r.result).toMatch(/^result:\s+PASS\s/);
    expect(r.exitCode).toBe(0);
  });

  it('inside an open secret-less window the answer is the same, and no order is looked up', async () => {
    const findUnique = vi.spyOn(fakeDb.alipayOrder as { findUnique: (...args: unknown[]) => unknown }, 'findUnique');
    const r = await runReal({ ALIPAY_CALLBACK_SECRET: SECRET, ALIPAY_SECRETLESS_UNTIL: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.result).toMatch(/^result:\s+PASS\s/);
    expect(findUnique).not.toHaveBeenCalled();
    findUnique.mockRestore();
  });

  it('without a callback secret, this code answers 503 / 50003: route reached, secret missing', async () => {
    const r = await runReal({});
    expect(r.output).toContain('status:   HTTP 503');
    expect(r.output).toContain('answer:   { code: 50003 }');
    expect(r.result).toMatch(/^result:\s+PASS-ROUTE \/ FAIL-SECRET\s/);
    expect(r.exitCode).toBe(1);
  });

  it('a host of this deployment that does not serve the route is a 404 and FAIL', async () => {
    vi.stubEnv('ALIPAY_CALLBACK_SECRET', SECRET);
    const result = await script.preflight({ origin: `${harness.baseUrl}/not-mounted` });
    expect(result.status).toBe(404);
    expect(result.verdict).toBe('FAIL');
    expect(result.exitCode).toBe(1);
  });
});
