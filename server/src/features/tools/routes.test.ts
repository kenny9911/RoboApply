// @vitest-environment node
//
// WP-57 route tests: every free-tool route answers through the platform
// envelope — multipart upload (200, 422 with a reason, 413-sized files as
// 422 file_too_large), the persisted allowance (429 + Retry-After), the
// GoApply notice by host (GoApply open on every stack, D5), the HttpOnly visitor
// cookie a run sets, result reads (422 bad id, 404 unknown or without the
// browser's cookie), the per-IP guard on the result routes and the claim
// (401 without a session, 404 from another browser, 200 with both). Public:
// no route requires a session.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { runChecklist, runRequirementRows } from './checks.js';
import {
  TOOLS_CONSENT_VERSION,
  TOOLS_VISITOR_COOKIE,
  type ClaimToolResultResponse,
  type ResumeCheckReport,
  type ToolsConfigView,
} from './contract.js';
import { FILES, POSTING, WEAK_RESUME_MD } from './fixtures.js';
import { createMemoryToolsStore } from './memoryStore.js';
import { createToolsPublicRouter } from './routes.js';
import { createToolsService, type ToolsRate, type ToolsServiceDeps } from './service.js';

const BASE = '/api/v1/public/tools';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

let h: RouteHarness;
/** 1234 s before the day's window resets. */
const NOW = new Date('2026-10-10T23:39:26.000Z');
const used = new Map<string, number>();
const rate: ToolsRate = {
  async consume(ip, brandId, _now, kind) {
    const k = `${brandId}|${ip}|${kind}`;
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    return { allowed: n <= 3, retryAfterSec: n <= 3 ? 0 : 1234 };
  },
  async remaining(ip, brandId, _now, kind) {
    return { remaining: Math.max(0, 3 - (used.get(`${brandId}|${ip}|${kind}`) ?? 0)), resetsAt: new Date('2026-10-11T00:00:00.000Z') };
  },
  async attempt() {
    return { allowed: true, retryAfterSec: 0 };
  },
};
const createResume = vi.fn(async () => ({ id: 'rv_claimed' }));
const deps = (env: Record<string, string>): ToolsServiceDeps => ({
  store: createMemoryToolsStore(),
  rate,
  parse: async (input) => ({ markdown: input.fileName.endsWith('.txt') ? input.buffer.toString('utf8') : WEAK_RESUME_MD, name: 'cv', via: 'local_text' }),
  checklist: (md, profile) => runChecklist(md, profile),
  requirementRows: (md, posting, profile) => runRequirementRows(md, posting, profile),
  createResume,
  brand: getCurrentBrand,
  env,
  now: () => NOW,
});
// GoApply on the mainland stack; a second router on an offshore deployment with only shared credentials (open too).
const service = createToolsService(deps({ DEPLOY_REGION: 'cn-mainland' }));
const offshore = createToolsService(deps({}));
const CN0 = '/cn0/tools';

/** Per-IP guard on the result routes: allows 50 per IP, counted here. */
const lookups = new Map<string, number>();
const lookupLimit: RequestHandler = (req, res, next) => {
  const k = String(req.headers['x-forwarded-for'] ?? 'none');
  const n = (lookups.get(k) ?? 0) + 1;
  lookups.set(k, n);
  if (n > 50) {
    res.status(429).json({ success: false, code: 'rate_limited' });
    return;
  }
  next();
};

/** optionalAuth stand-in: `x-test-user` header → user (no header → anonymous, never 401). */
const optional: RequestHandler = (req, _res, next) => {
  const id = req.headers['x-test-user'];
  if (typeof id === 'string') (req as unknown as { user: { id: string; brand: string } }).user = { id, brand: 'roboapply' };
  next();
};

beforeAll(async () => {
  h = await startRouteHarness({
    mounts: [
      [BASE, createToolsPublicRouter({ optionalAuth: [optional] }, { service, resultLookupLimit: lookupLimit })],
      [CN0, createToolsPublicRouter({ optionalAuth: [optional] }, { service: offshore, resultLookupLimit: lookupLimit })],
    ],
  });
});
afterAll(async () => {
  await h.close();
});

async function upload<T>(
  path: string,
  parts: Record<string, string | { data: Buffer; name: string; type: string }>,
  headers: Record<string, string> = {},
  base: string = BASE,
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === 'string') form.set(k, v);
    else form.set(k, new Blob([new Uint8Array(v.data)], { type: v.type }), v.name);
  }
  const res = await fetch(`${h.baseUrl}${base}${path}`, { method: 'POST', body: form, headers });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Env<T> };
}

const txt = (text = WEAK_RESUME_MD) => ({ data: FILES.txt(text), name: 'resume.txt', type: 'text/plain' });
const ip = (n: string) => ({ 'x-forwarded-for': n });
/** The visitor cookie value from a run's Set-Cookie. */
function visitorFrom(headers: Headers): string {
  const set = headers.get('set-cookie') ?? '';
  const m = new RegExp(`${TOOLS_VISITOR_COOKIE}=([^;]+)`).exec(set);
  return m ? decodeURIComponent(m[1]!) : '';
}

describe('free tool routes', () => {
  let resultId = '';
  let visitor = '';

  it('GET /config answers the limits without a session', async () => {
    const res = await h.request<Env<ToolsConfigView>>('GET', `${BASE}/config`, { headers: ip('10.0.0.1') });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      available: true,
      perIpPerDay: 3,
      remainingByTool: { resume_check: 3, resume_job_match: 3 },
      consentRequired: false,
      shortReportIssues: 3,
    });
  });

  it('POST /resume-check → 200 short report, and an HttpOnly visitor cookie scoped to the tools API', async () => {
    const res = await upload<ResumeCheckReport>('/resume-check', { resume: txt() }, ip('10.0.0.1'));
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('resume_check');
    expect(res.body.data.issues).toHaveLength(3);
    expect(res.body.data.method).toBe('rules');
    resultId = res.body.data.resultId;
    expect(resultId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\/api\/v1\/public\/tools/);
    visitor = visitorFrom(res.headers);
    expect(visitor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A run with the cookie keeps it (refreshed, same value).
    const again = await upload('/resume-check', { resume: txt(`${WEAK_RESUME_MD}\n- again`) }, { ...ip('10.0.0.1'), cookie: `${TOOLS_VISITOR_COOKIE}=${visitor}` });
    expect(visitorFrom(again.headers)).toBe(visitor);
  });

  it('422 with a reason for a missing or wrong file', async () => {
    const none = await upload('/resume-check', { other: 'x' }, ip('10.0.0.2'));
    expect(none.status).toBe(422);
    expect(none.body.details?.reason).toBe('file_missing');
    const img = await upload('/resume-check', { resume: { data: FILES.png(), name: 'cv.png', type: 'image/png' } }, ip('10.0.0.2'));
    expect(img.status).toBe(422);
    expect(img.body.code).toBe('invalid_request');
    expect(img.body.details?.reason).toBe('file_wrong_type');
  });

  it('a file over 15 MB is refused by the upload reader (422 file_too_large)', async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 10, 0x41);
    const res = await upload('/resume-check', { resume: { data: big, name: 'cv.txt', type: 'text/plain' } }, ip('10.0.0.3'));
    expect(res.status).toBe(422);
    expect(res.body.details?.reason).toBe('file_too_large');
  });

  it('POST /resume-job-match → 200 rows; 422 without the posting', async () => {
    const ok = await upload<{ rows: unknown[] }>('/resume-job-match', { resume: txt(), postingTitle: POSTING.title, postingText: POSTING.text }, ip('10.0.0.4'));
    expect(ok.status).toBe(200);
    expect(ok.body.data.rows.length).toBe(5);
    const bad = await upload('/resume-job-match', { resume: txt() }, ip('10.0.0.4'));
    expect(bad.status).toBe(422);
    expect(bad.body.details?.reason).toBe('posting_title_missing');
  });

  it('the fourth new run of one tool from one IP is 429 with Retry-After; the other tool still runs', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await upload('/resume-check', { resume: txt(`${WEAK_RESUME_MD}\n- run ${i}`) }, ip('10.0.0.9'));
      expect(r.status).toBe(200);
    }
    const res = await upload('/resume-check', { resume: txt(`${WEAK_RESUME_MD}\n- run 4`) }, ip('10.0.0.9'));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.headers.get('retry-after')).toBe('1234');
    const job = await upload('/resume-job-match', { resume: txt(), postingTitle: POSTING.title, postingText: POSTING.text }, ip('10.0.0.9'));
    expect(job.status).toBe(200);
  });

  it('GoApply (by host) needs the processing notice', async () => {
    const host = { 'x-forwarded-host': 'goapply.top', ...ip('10.0.1.1') };
    const cfg = await h.request<Env<ToolsConfigView>>('GET', `${BASE}/config`, { host: 'goapply.top' });
    expect(cfg.body.data.consentRequired).toBe(true);
    const no = await upload('/resume-check', { resume: txt() }, host);
    expect(no.status).toBe(422);
    expect(no.body.details?.reason).toBe('consent_required');
    const yes = await upload<ResumeCheckReport>('/resume-check', { resume: txt(), consent: TOOLS_CONSENT_VERSION }, host);
    expect(yes.status).toBe(200);
    expect(yes.body.data.profile).toBe('cn');
  });

  it('GoApply on an offshore deployment with no CN_ value: available, the notice names processing outside the mainland, a ticked run answers 200', async () => {
    const host = { 'x-forwarded-host': 'goapply.top', ...ip('10.0.1.2') };
    const cfg = await h.request<Env<ToolsConfigView>>('GET', `${CN0}/config`, { host: 'goapply.top' });
    expect(cfg.status).toBe(200);
    expect(cfg.body.data).toMatchObject({ available: true, consentRequired: true, consentVersion: TOOLS_CONSENT_VERSION, processedOutsideMainland: true });
    const no = await upload('/resume-check', { resume: txt() }, host, CN0);
    expect(no.status).toBe(422);
    expect(no.body.details?.reason).toBe('consent_required');
    const run = await upload<ResumeCheckReport>('/resume-check', { resume: txt(), consent: TOOLS_CONSENT_VERSION }, host, CN0);
    expect(run.status).toBe(200);
    expect(run.body.data.profile).toBe('cn');
    const match = await upload('/resume-job-match', { resume: txt(), consent: TOOLS_CONSENT_VERSION, postingTitle: POSTING.title, postingText: POSTING.text }, host, CN0);
    expect(match.status).toBe(200);
    // RoboApply on the same stack: open, no notice, no outside-the-mainland line.
    expect((await h.request<Env<ToolsConfigView>>('GET', `${CN0}/config`)).body.data).toMatchObject({ available: true, consentRequired: false, processedOutsideMainland: false });
  });

  it('GET /results/:id → short view with this browser’s cookie; 404 without it or from another browser; 422 for a malformed id', async () => {
    const mine = { cookies: { [TOOLS_VISITOR_COOKIE]: visitor } };
    const res = await h.request<Env<ResumeCheckReport>>('GET', `${BASE}/results/${resultId}`, mine);
    expect(res.status).toBe(200);
    expect(res.body.data.full).toBe(false);
    expect((await h.request('GET', `${BASE}/results/${resultId}`)).status).toBe(404);
    expect((await h.request('GET', `${BASE}/results/${resultId}`, { cookies: { [TOOLS_VISITOR_COOKIE]: 'z'.repeat(43) } })).status).toBe(404);
    expect((await h.request('GET', `${BASE}/results/bad id`, mine)).status).toBe(422);
    const unknown = await h.request<Env<unknown>>('GET', `${BASE}/results/${'a'.repeat(43)}`, mine);
    expect(unknown.status).toBe(404);
  });

  it('the result routes are rate-limited per IP', async () => {
    const who = ip('10.0.7.7');
    for (let i = 0; i < 50; i += 1) await h.request('GET', `${BASE}/results/${'b'.repeat(43)}`, { headers: who });
    expect((await h.request('GET', `${BASE}/results/${'b'.repeat(43)}`, { headers: who })).status).toBe(429);
    expect((await h.request('POST', `${BASE}/results/${'b'.repeat(43)}/claim`, { headers: { ...who, 'x-test-user': 'u' } })).status).toBe(429);
  });

  it('POST /results/:id/claim → 401 without a session, 404 from another browser, 200 from this one (full report)', async () => {
    const anon = await h.request<Env<unknown>>('POST', `${BASE}/results/${resultId}/claim`, { cookies: { [TOOLS_VISITOR_COOKIE]: visitor } });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('unauthorized');
    const elsewhere = await h.request<Env<unknown>>('POST', `${BASE}/results/${resultId}/claim`, { headers: { 'x-test-user': 'user_9' } });
    expect(elsewhere.status).toBe(404);
    expect(createResume).not.toHaveBeenCalled();
    const res = await h.request<Env<ClaimToolResultResponse>>('POST', `${BASE}/results/${resultId}/claim`, {
      headers: { 'x-test-user': 'user_1' },
      cookies: { [TOOLS_VISITOR_COOKIE]: visitor },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.resumeId).toBe('rv_claimed');
    expect(res.body.data.report.full).toBe(true);
    expect(createResume).toHaveBeenCalledWith('user_1', expect.objectContaining({ markdown: expect.stringContaining('Sam Rivera') }));
  });
});
