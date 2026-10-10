// @vitest-environment node
//
// FND-5 acceptance: every router in FEATURE_MOUNTS answers
//   - 401 without credentials on every authenticated route (default auth chains),
//   - 501 not_implemented with auth and its capability on (valid input) on
//     every route whose handler is still a stub (`markStub`, platform/http.ts),
//   - 404 feature_disabled on every capability-gated route with the capability off,
// and public mounts never require a session. One describe block per router.
// Routes are discovered from the Express router stacks.
//
// Filling a route needs no edit here (TASK_PLAN.md §2.1): a handler that is
// no longer tagged as a stub is skipped by the 501 check, and its owner tests
// it in its own area. A WP that changes the contract of a route that is STILL
// a stub, so the sample below no longer parses, exports
// `ROUTE_SAMPLES: Record<string, RouteSample>` (same keys) from its own
// `routes.ts`; those override the table below.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEATURE_MOUNTS, type FeatureMount, type FeatureRouterDeps } from './index.js';
import { isStubHandler } from '../platform/http.js';
import { FLAG_KEYS, flagEnvName, setFlagOverrideLoader } from '../platform/flags.js';
import type { EnvSource } from '../platform/brand/brandEnv.js';
import { fakeAuth, startRouteHarness, type HarnessResponse, type RouteHarness } from '../test/routeHarness.js';

// ── Valid inputs for routes whose contract requires some ─────────────────

interface RouteSample {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/** Keyed `<mount id> <METHOD> <route path>`; only stub routes that 422 on empty input need one. */
const BASE_ROUTE_SAMPLES: Record<string, RouteSample> = {
  // auth
  'auth POST /password/forgot': { body: { email: 'u@example.test' } },
  'auth POST /password/reset': { body: { token: 't'.repeat(32), password: 'abcd1234' } },
  'auth GET /email/verify': { query: { token: 't'.repeat(32) } },
  'auth.account POST /consents': { body: { type: 'analytics', granted: true, proseVersion: 'v1' } },
  // auth-cn
  'auth-cn.phone POST /send-code': { body: { phone: '13812345678', purpose: 'login' } },
  'auth-cn.phone POST /verify': { body: { phone: '13812345678', code: '123456' } },
  'auth-cn.phone POST /bind': { body: { phone: '13812345678', code: '123456' } },
  'auth-cn.phone POST /change': { body: { oldCode: '123456', newPhone: '13912345678', newCode: '654321' } },
  'auth-cn.wechat POST /mini/login': { body: { code: 'wx-code' } },
  'auth-cn.admin POST /invites': { body: { count: 5 } },
  // account-v2
  'account-v2.2fa POST /verify': { body: { code: '123456' } },
  'account-v2.2fa POST /disable': { body: { code: '123456' } },
  'account-v2.2fa POST /recovery-codes': { body: { code: '123456' } },
  'account-v2.student POST /verify-email/send': { body: { schoolEmail: 's@uni.example.edu' } },
  'account-v2.student POST /verify-email/confirm': { body: { code: '123456' } },
  // compliance
  'compliance POST /pi-requests': { body: { kind: 'access' } },
  'compliance.legal GET /:doc': { params: { doc: 'privacy' } },
  // onboarding
  'onboarding PUT /steps/:step': { params: { step: 'situation' }, body: { timing: 'asap', seekerType: 'experienced' } },
  'onboarding GET /title-suggest': { query: { q: 'product' } },
  'onboarding GET /market-snapshot': { query: { taxonomyId: 'swe', country: 'US' } },
  'onboarding POST /resume': { body: { resumeVariantId: 'rv_1' } },
  'onboarding POST /confirm': { body: { experienceLevels: ['mid'], alertFrequency: 'daily' } },
  // profile
  'profile POST /education': { body: { school: 'State University' } },
  'profile POST /experience': { body: { company: 'Acme', title: 'Engineer' } },
  'profile PUT /skills': { body: { skills: [{ name: 'SQL', confirmed: true }] } },
  'profile POST /sync-from-resume': { body: { variantId: 'rv_1' } },
  'profile POST /sync-from-resume/apply': { body: { variantId: 'rv_1', accept: ['skills'] } },
  // search
  'search.profiles POST /': { body: { name: '', filters: {} } },
  'search.profiles POST /count': { body: { filters: {} } },
  'search.profiles PATCH /:id': { body: { version: 1, name: 'Data roles' } },
  'search.taxonomy GET /skills': { query: { q: 'py' } },
  // feed
  'feed POST /jobs/:id/hide': { body: { reasonCode: 'wrong_level' } },
  'feed POST /jobs/:id/report': { body: { reason: 'expired' } },
  'feed POST /impressions': { body: { sessionId: 's1', positions: [{ jobId: 'j1', position: 0, ms: 1200 }] } },
  'feed POST /rating': { body: { score: 7, reasons: ['wrong_level'] } },
  'feed POST /nl-query': { body: { text: 'remote data jobs' } },
  // jobs
  'jobs.companies GET /': { query: { q: 'ac' } },
  'jobs.careerSources.admin POST /': { body: { ats: 'greenhouse', boardToken: 'acme', companyName: 'Acme', countryCode: 'TW' } },
  'match POST /competitiveness': { body: { searchProfileId: 'sp_1' } },
  // copilot
  'copilot POST /threads/:id/messages': { body: { text: 'Why do I fit?', chip: 'why_fit' } },
  'copilot POST /messages/:id/feedback': { body: { value: 'up' } },
  // resume
  'resume POST /tailor-sessions': { body: { baseVariantId: 'rv_1', jobId: 'j1', mode: 'guided', sections: ['summary', 'experience'] } },
  'resume PATCH /tailor-sessions/:id/claims/:claimId': { body: { status: 'kept' } },
  'resume POST /:id/issues/:issueId/fix': { body: { variant: 'shorter' } },
  'resume POST /:id/keyword-report': { body: { jobId: 'j1' } },
  'resume PATCH /:id/layout': { body: { layout: { template: 'standard', page: 'letter' } } },
  // cover letters
  'coverletter POST /': { body: { jobId: 'j1', resumeVariantId: 'rv_1', tone: 'warm' } },
  'coverletter POST /:id/rewrite': { body: { instruction: 'Shorter, please.' } },
  'coverletter POST /:id/restore': { body: { versionIndex: 0 } },
  'coverletter GET /:id/export': { query: { format: 'pdf' } },
  // tracker, offers, network
  'tracker POST /:id/events': { body: { note: 'Called the recruiter.' } },
  'offers POST /compare': { body: { trackerEntryIds: ['t1', 't2'] } },
  'offers PUT /:trackerEntryId': { body: { base: 120000, currency: 'USD', period: 'year' } },
  'network POST /contacts': { body: { fullName: 'Ada Lovelace', companyName: 'Acme' } },
  'network POST /outreach-drafts': { body: { jobId: 'j1', channel: 'linkedin_note' } },
  'cn.referrals POST /': { body: { company: '某公司', code: 'ABC123' } },
  'cn.referrals POST /:id/report': { body: { reason: 'expired' } },
  // agent
  'agent POST /setup/calibration': { body: { jobId: 'j1', verdict: 'up' } },
  'agent POST /queue': { body: { jobIds: ['j1'] } },
  'agent POST /queue/:id/confirm': { body: { part: 'resume', decision: 'use' } },
  'agent PUT /answers': { body: { answers: [{ questionKey: 'notice_period', questionText: 'Notice period?', answer: 'Two weeks', locale: 'en' }] } },
  // extension
  'extension POST /devices': { body: { name: 'Chrome on Mac', browser: 'chrome', extVersion: '1.0.0' } },
  'extension POST /pair-codes/redeem': { body: { code: 'ABCD1234', name: 'Edge' } },
  'extension POST /page-job': { body: { url: 'https://jobs.example.test/1', title: 'Engineer', company: 'Acme', descriptionText: 'Build things.' } },
  'extension POST /jobs/save': { body: { url: 'https://jobs.example.test/1', title: 'Engineer', company: 'Acme', descriptionText: 'Build things.' } },
  'extension POST /autofill-runs': { body: { host: 'boards.greenhouse.io', atsType: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', fieldsTotal: 12 } },
  'extension PATCH /autofill-runs/:id': { body: { fieldsFilled: 10, outcome: 'partial' } },
  'extension POST /answers': { body: { runId: 'run_1', question: 'Why us?', fieldType: 'textarea' } },
  'extension POST /resume-for-job': { body: { jobId: 'j1', runId: 'run_1' } },
  'extension POST /site-requests': { body: { host: 'jobs.example.test', url: 'https://jobs.example.test/apply' } },
  'extension.public POST /uninstall-survey': { body: { reasons: ['not_useful'] } },
  // credits
  'credits.cancel POST /': { body: { email: 'u@example.test' } },
  'credits.cancel POST /confirm': { body: { token: 't'.repeat(32) } },
  'credits.admin PUT /catalog': { body: { override: { roboapply: {} } } },
  'credits.admin POST /overrides': { body: { userId: 'u1', key: 'flag:coaching', value: true, reason: 'Beta tester' } },
  'credits.admin PUT /fx-reference': { body: { currency: 'TWD', ratePerUsd: 32.1, source: 'Central bank', asOf: '2026-10-01' } },
  'billing-cn POST /': { body: { planKey: 'pro_monthly', tradeType: 'native', termsVersion: 'v1' } },
  // notifications
  'notifications POST /:id/respond': { body: { interested: true } },
  'notifications.email GET /unsubscribe': { query: { token: 't'.repeat(32) } },
  'notifications.email POST /unsubscribe': { query: { token: 't'.repeat(32) }, body: { 'List-Unsubscribe': 'One-Click' } },
  'notifications.email POST /unsubscribe/survey': { body: { token: 't'.repeat(32), reason: 'too_many' } },
  'push POST /subscriptions': { body: { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'k', auth: 'a' } } },
  'announcements.admin POST /': {
    body: { key: 'launch.note', brand: 'roboapply', locales: ['en'], content: { en: { title: 'New', body: 'Something new.' } } },
  },
  // growth
  'growth.events POST /': { body: { events: [{ name: 'page_viewed', at: '2026-10-10T00:00:00.000Z' }] } },
  // prep, coaching
  'prep POST /questions/:id/report': { body: { reason: 'wrong' } },
  'prep POST /contributions': { body: { company: 'Acme', question: 'Tell me about a hard bug you fixed.' } },
  'prep.admin POST /contributions/:id/reject': { body: { reason: 'Duplicate' } },
  'coaching POST /coaches/:id/request': { body: { topic: 'Mock interview', contactEmail: 'u@example.test' } },
  'coaching.admin POST /coaches': {
    body: { brand: 'roboapply', displayName: 'Coach A', headline: 'Career coach', bio: 'Ten years of hiring.' },
  },
  // seo
  'seo GET /page': { query: { type: 'role', slug: 'data-analyst' } },
  'seo GET /sitemap/:part': { params: { part: 'jobs-1' } },
  // cn
  'cn.jobs GET /external-links': { query: { q: '产品经理' } },
  'cn.jobs.admin POST /fraud/:jobId/resolve': { body: { decision: 'clear' } },
  'cn.jobs.admin POST /blacklist': { body: { employerName: '某公司', reason: '收费' } },
  'cn.campus POST /subscriptions': { body: { kind: 'event', eventId: 'ev_1' } },
  'cn.campus.admin POST /events/extract': { body: { officialUrl: 'https://campus.example.cn/2027' } },
  'cn.campus.admin POST /events': {
    body: { companyName: '某公司', title: '2027届校园招聘', graduationClass: '2027届', officialUrl: 'https://campus.example.cn/2027' },
  },
  'notify-cn POST /subscribe-messages': { body: { templateKeys: ['deadline_reminder'], scene: 'campus_deadline', results: { deadline_reminder: 'accept' } } },
  'notify-cn GET /js-sdk-signature': { query: { url: 'https://www.goapply.top/campus' } },
  // support, visitor, admin
  'support POST /contact': { body: { email: 'u@example.test', topic: 'bug', message: 'The page did not load.' } },
  'visitor.copilot POST /': { body: { text: 'Remote data jobs?', pageContext: { path: '/browse/data-analyst' } } },
  'visitor.alerts POST /': { body: { email: 'u@example.test', filters: { q: 'data analyst' }, locale: 'en', consent: true } },
  'visitor.alerts GET /confirm': { query: { token: 't'.repeat(32) } },
  'visitor.alerts POST /unsubscribe': { body: { token: 't'.repeat(32) } },
  'admin POST /reports/:id/resolve': { body: { decision: 'keep_job' } },
  'admin POST /overrides': { body: { userId: 'u1', key: 'bucket:tailor', value: 5, reason: 'Support case' } },
};

/** Area overrides: `export const ROUTE_SAMPLES` from any features/**\/*routes.ts (owned by the area). */
async function loadAreaSamples(): Promise<Record<string, RouteSample>> {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/outes\.ts$/.test(name) && !name.endsWith('.test.ts')) files.push(full);
    }
  };
  walk(root);
  const out: Record<string, RouteSample> = {};
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as { ROUTE_SAMPLES?: Record<string, RouteSample> };
    if (mod.ROUTE_SAMPLES) Object.assign(out, mod.ROUTE_SAMPLES);
  }
  return out;
}

const FEATURE_ROUTE_SAMPLES: Record<string, RouteSample> = { ...BASE_ROUTE_SAMPLES, ...(await loadAreaSamples()) };

// ── Route discovery ──────────────────────────────────────────────────────

interface DiscoveredRoute {
  method: string;
  path: string;
  handlerNames: string[];
  /** The terminal handler is still a FND stub (answers 501 until filled). */
  stub: boolean;
}

function discover(router: Router): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const stack = (
    router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ name: string; handle: unknown }> } }>;
    }
  ).stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    const handlers = layer.route.stack;
    const stub = handlers.length > 0 && isStubHandler(handlers[handlers.length - 1]!.handle);
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path, handlerNames: handlers.map((l) => l.name), stub });
    }
  }
  return out;
}

const AUTH_NAMES = new Set(['requireAuth', 'requireExtensionDevice']);
const GATE_NAMES = new Set(['flagGate', 'hiringContactsGate']);
const isAuthed = (r: DiscoveredRoute) => r.handlerNames.some((n) => AUTH_NAMES.has(n));
const isGated = (r: DiscoveredRoute) => r.handlerNames.some((n) => GATE_NAMES.has(n));

function fill(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z_]+)/g, (_m, name: string) => encodeURIComponent(params[name] ?? `test-${name}`));
}

function sampleKey(mount: FeatureMount, r: DiscoveredRoute): string {
  return `${mount.id} ${r.method} ${r.path}`;
}

function urlFor(mount: FeatureMount, r: DiscoveredRoute, sample?: RouteSample): string {
  const base = `${mount.path}${fill(r.path, sample?.params)}`.replace(/\/$/, '') || '/';
  const qs = sample?.query ? `?${new URLSearchParams(sample.query).toString()}` : '';
  return `${base}${qs}`;
}

// ── Env: every capability on / off ───────────────────────────────────────

const REQUIREMENTS: EnvSource = {
  NODE_ENV: 'development',
  GOOGLE_OAUTH_CLIENT_ID: 'id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  LINE_LOGIN_CHANNEL_ID: 'id',
  LINE_LOGIN_CHANNEL_SECRET: 'secret',
  SMS_DEV_CONSOLE: 'true',
  WECHAT_OPEN_APP_ID: 'wx',
  WECHAT_OPEN_APP_SECRET: 's',
  WECHAT_MP_APP_ID: 'wx',
  WECHAT_MP_APP_SECRET: 's',
  WECHAT_MP_TOKEN: 't',
  WECHAT_MINI_APP_ID: 'wx',
  WECHAT_MINI_APP_SECRET: 's',
  RESEND_API_KEY: 're_test',
  CN_EMAIL_TRANSPORT: 'resend',
  CN_EMAIL_FROM: 'noreply@example.test',
  STRIPE_SECRET_KEY: 'sk_test_x',
  CN_PAYMENTS_ENABLED: 'true',
  ALIPAY_API_URL: 'https://alipay.example.test',
  ALIPAY_CALLBACK_SECRET: 's',
  WECHATPAY_MCH_ID: 'm',
  WECHATPAY_APP_ID: 'a',
  WECHATPAY_API_V3_KEY: 'k',
  WECHATPAY_MCH_CERT_SERIAL: 's',
  WECHATPAY_MCH_PRIVATE_KEY: 'p',
  CN_LLM_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'k',
  CN_LLM_MODEL: 'deepseek-chat',
  CN_LLM_VISION_MODEL: 'v',
  CN_RECRUITMENT_INFO_MODE: 'licensed',
  CN_CAMPUS_CALENDAR_ENABLED: 'true',
};

function flagsEnv(on: boolean): EnvSource {
  const env: EnvSource = { ...REQUIREMENTS };
  for (const brand of ['roboapply', 'goapply'] as const) {
    for (const key of FLAG_KEYS) env[flagEnvName(brand, key)] = on ? 'true' : 'false';
    env[flagEnvName(brand, 'hiringContacts')] = on ? 'on' : 'off';
  }
  return env;
}

const ENV_ON = flagsEnv(true);
const ENV_OFF = flagsEnv(false);
const HOSTS = ['localhost:3621', 'goapply.localhost:3621'] as const;

const seeker = { id: 'user_test_1', email: 'u@example.test', role: 'seeker', brand: undefined };
const adminUser = { id: 'admin_test_1', email: 'a@example.test', role: 'admin' };
const passThrough: RequestHandler = (_req, _res, next) => next();

function injected(env: EnvSource): FeatureRouterDeps {
  return {
    seekerAuth: [fakeAuth(seeker)],
    adminAuth: [fakeAuth(adminUser)],
    optionalAuth: [passThrough],
    extensionAuth: [fakeAuth(seeker)],
    env,
  };
}

async function send(h: RouteHarness, mount: FeatureMount, r: DiscoveredRoute, host: string, sample?: RouteSample): Promise<HarnessResponse<{ code?: string }>> {
  return h.request<{ code?: string }>(r.method, urlFor(mount, r, sample), { host, body: sample?.body });
}

// ── Harnesses ────────────────────────────────────────────────────────────

let defaultHarness: RouteHarness;
let onHarness: RouteHarness;
let offHarness: RouteHarness;

beforeAll(async () => {
  setFlagOverrideLoader(async () => []);
  defaultHarness = await startRouteHarness({ env: ENV_ON, mounts: FEATURE_MOUNTS.map((m) => [m.path, m.build({ env: ENV_ON })]) });
  onHarness = await startRouteHarness({ env: ENV_ON, mounts: FEATURE_MOUNTS.map((m) => [m.path, m.build(injected(ENV_ON))]) });
  offHarness = await startRouteHarness({ env: ENV_OFF, mounts: FEATURE_MOUNTS.map((m) => [m.path, m.build(injected(ENV_OFF))]) });
});

afterAll(async () => {
  setFlagOverrideLoader(null);
  await Promise.all([defaultHarness?.close(), onHarness?.close(), offHarness?.close()]);
});

// ── Table sanity ─────────────────────────────────────────────────────────

describe('FEATURE_MOUNTS', () => {
  it('has unique ids and unique paths', () => {
    expect(new Set(FEATURE_MOUNTS.map((m) => m.id)).size).toBe(FEATURE_MOUNTS.length);
    expect(new Set(FEATURE_MOUNTS.map((m) => m.path)).size).toBe(FEATURE_MOUNTS.length);
  });

  it('mounts /jobs/import before /jobs, and parents before their children', () => {
    const at = (p: string) => FEATURE_MOUNTS.findIndex((m) => m.path === p);
    expect(at('/api/v1/roboapply/jobs/import')).toBeLessThan(at('/api/v1/roboapply/jobs'));
    expect(at('/api/v1/roboapply/auth')).toBeLessThan(at('/api/v1/roboapply/auth/phone'));
    expect(at('/api/v1/roboapply/account')).toBeLessThan(at('/api/v1/roboapply/account/2fa'));
  });

  it('never mounts the public brand route (app.ts owns it)', () => {
    expect(FEATURE_MOUNTS.some((m) => m.path === '/api/v1/public/brand')).toBe(false);
  });

  it('keeps every mount under the four API roots', () => {
    for (const m of FEATURE_MOUNTS) {
      expect(m.path).toMatch(/^\/api\/v1\/(roboapply|public|webhooks)(\/|$)/);
      if (m.kind === 'admin') expect(m.path.startsWith('/api/v1/roboapply/admin')).toBe(true);
      if (m.kind === 'webhook') expect(m.path.startsWith('/api/v1/webhooks/')).toBe(true);
      if (m.path.startsWith('/api/v1/public/')) expect(m.kind).toBe('public');
    }
  });

  it('detects stub handlers through the router stack (guards the 501 check against running vacuously)', async () => {
    const { Router: makeRouter } = await import('express');
    const { markStub, route } = await import('../platform/http.js');
    const r = makeRouter();
    r.get('/stub', passThrough, markStub(route(async () => null)));
    r.get('/real', passThrough, route(async () => null));
    expect(discover(r).map((x) => [x.path, x.stub])).toEqual([
      ['/stub', true],
      ['/real', false],
    ]);
  });

  it('keys every sample by a mounted router id (a filled or removed route just leaves its sample unused)', () => {
    const ids = new Set(FEATURE_MOUNTS.map((m) => m.id));
    expect(Object.keys(FEATURE_ROUTE_SAMPLES).filter((k) => !ids.has(k.split(' ')[0]!))).toEqual([]);
  });
});

// ── Per router ───────────────────────────────────────────────────────────

describe.each(FEATURE_MOUNTS.map((m) => [m.id, m] as const))('router %s', (_id, mount) => {
  const routes = discover(mount.build({}));

  it('declares at least one route', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('applies auth per the mount kind', () => {
    for (const r of routes) {
      if (mount.kind === 'admin') {
        expect(r.handlerNames, `${r.method} ${r.path}`).toEqual(expect.arrayContaining(['requireAuth', 'requireAdmin']));
      }
      if (mount.kind === 'public' || mount.kind === 'webhook') {
        expect(r.handlerNames, `${r.method} ${r.path}`).not.toContain('requireAuth');
      }
    }
  });

  it('answers 401 without credentials on every authenticated route', async () => {
    for (const r of routes.filter(isAuthed)) {
      const res = await send(defaultHarness, mount, r, HOSTS[0]);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('answers 501 not_implemented with auth and its capability on (stub routes only)', async () => {
    if (mount.kind === 'webhook') return; // raw-body contract: features/mount.test.ts
    const mismatches: string[] = [];
    // Filled routes (no longer `markStub`) carry their owners' tests.
    for (const r of routes.filter((x) => x.stub)) {
      const key = sampleKey(mount, r);
      const sample = FEATURE_ROUTE_SAMPLES[key];
      let last: HarnessResponse<{ code?: string }> | null = null;
      for (const host of HOSTS) {
        last = await send(onHarness, mount, r, host, sample);
        if (!(last.status === 404 && last.body?.code === 'feature_disabled')) break;
      }
      if (last!.status !== 501 || last!.body?.code !== 'not_implemented') mismatches.push(`${key} → ${last!.status} ${last!.text}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('answers 404 feature_disabled on every gated route with its capability off', async () => {
    for (const r of routes.filter(isGated)) {
      const sample = FEATURE_ROUTE_SAMPLES[sampleKey(mount, r)];
      for (const host of HOSTS) {
        const res = await send(offHarness, mount, r, host, sample);
        expect(res.status, `${r.method} ${r.path} @${host}`).toBe(404);
        expect(res.body?.code).toBe('feature_disabled');
      }
    }
  });
});
