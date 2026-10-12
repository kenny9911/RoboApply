// @vitest-environment node
//
// The first-party prep routes (prep/routes.ts) on a small Express app: fake
// auth and first-party guards, fake limiters, and the brand gate, market
// context, job finder, industry roles and planner faked. Checks validation
// (422), the AI gate, error mapping (404 job_not_found, 500 prep_failed,
// 503 prep_unavailable) and the 200 shapes. No model, search or database.
// Run: npx vitest run server/src/interview-engine/prep/routes.test.ts
// (it listens on 127.0.0.1: run it outside a sandbox that forbids local ports).

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductBrand } from '../../platform/brand/registry.js';

const m = vi.hoisted(() => ({
  brand: null as unknown as ProductBrand,
  gateOpen: true,
  aiGateOpen: vi.fn(),
  resolvePrepMarket: vi.fn(),
  findJobs: vi.fn(),
  rolesForIndustry: vi.fn(),
  planInterview: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  generateRequestId: () => 'req-test',
}));
vi.mock('../../platform/ratelimit/index.js', () => ({ rateLimit: m.rateLimit }));
vi.mock('../routes/practiceGate.js', () => ({ currentBrand: async () => m.brand, aiGateOpen: m.aiGateOpen }));
vi.mock('./marketContext.js', () => ({ resolvePrepMarket: m.resolvePrepMarket }));
vi.mock('./jobFinder.js', () => ({ findJobs: m.findJobs }));
vi.mock('./industryRoles.js', () => ({ rolesForIndustry: m.rolesForIndustry }));
vi.mock('./planner.js', () => {
  class PrepJobNotFoundError extends Error {
    readonly code = 'job_not_found';
  }
  return { planInterview: m.planInterview, PrepJobNotFoundError };
});

import { getBrand } from '../../platform/brand/registry.js';

const robo = getBrand('roboapply');
const go = getBrand('goapply');
const CTX = { brand: robo, formatMarket: 'intl', country: 'US', marketKey: 'us', marketLabel: 'United States and Canada' };

const pass: RequestHandler = (_req, _res, next) => next();
const limiters = { search: vi.fn(pass), roles: vi.fn(pass), plan: vi.fn(pass) };

let server: Server;
let base: string;

beforeAll(async () => {
  const express = (await import('express')).default;
  const { createPrepRouter } = await import('./routes.js');
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (req.get('x-test-anonymous')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    (req as Request & { user?: unknown }).user = { id: 'u1', name: 'Jane Doe', role: 'seeker' };
    next();
  };
  const requireFirstParty: RequestHandler = (req, res, next) => {
    if (req.get('x-api-key')) {
      res.status(403).json({ error: 'first_party_only' });
      return;
    }
    next();
  };
  app.use('/prep', createPrepRouter({ requireAuth, requireFirstParty, limiters }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  m.brand = robo;
  m.gateOpen = true;
  m.aiGateOpen.mockImplementation(async (_req: Request, res: Response) => {
    if (m.gateOpen) return true;
    res.status(503).json({ error: 'ai_unavailable', reason: 'ai_consent_required' });
    return false;
  });
  m.resolvePrepMarket.mockResolvedValue(CTX);
  limiters.search.mockImplementation(pass);
  limiters.roles.mockImplementation(pass);
  limiters.plan.mockImplementation(pass);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/prep${path}`, {
    method,
    headers: { 'x-robo-locale': 'en', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any> };
}

describe('every prep route is first-party and signed in', () => {
  it.each([
    ['GET', '/industries', undefined],
    ['POST', '/roles', { industry: 'ai' }],
    ['POST', '/search', { query: 'AI FDE' }],
    ['POST', '/plan', { role: 'Backend Engineer' }],
  ])('%s %s', async (method, path, body) => {
    expect((await call(method, path, body, { 'x-test-anonymous': '1' })).status).toBe(401);
    expect((await call(method, path, body, { 'x-api-key': 'k' })).status).toBe(403);
    for (const fake of [m.rolesForIndustry, m.findJobs, m.planInterview, m.resolvePrepMarket]) expect(fake).not.toHaveBeenCalled();
  });
});

describe('GET /industries', () => {
  it('lists the industries in the order of the interface language’s market, labelled in it', async () => {
    const ja = await call('GET', '/industries', undefined, { 'x-robo-locale': 'ja' });
    expect(ja.status).toBe(200);
    expect(ja.body.industries).toHaveLength(27);
    expect(ja.body.industries[0]).toEqual({ id: 'manufacturing_industrial', label: '製造・工業', top: true });
    const en = await call('GET', '/industries');
    expect(en.body.industries[0]).toEqual({ id: 'software_internet', label: 'Software & Internet', top: true });
    // A static list: no gate, no model.
    expect(m.aiGateOpen).not.toHaveBeenCalled();
  });

  it('GoApply lists the mainland order in a locale the brand offers', async () => {
    m.brand = go;
    const res = await call('GET', '/industries', undefined, { 'x-robo-locale': 'ja' });
    expect(res.body.industries.slice(0, 3)).toEqual([
      { id: 'software_internet', label: '软件与互联网', top: true },
      { id: 'ai', label: '人工智能', top: true },
      { id: 'semiconductors_electronics', label: '半导体与电子', top: true },
    ]);
  });
});

describe('POST /roles', () => {
  it('422 without an industry, before the gate or the model', async () => {
    const res = await call('POST', '/roles', {});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('validation_error');
    expect(m.aiGateOpen).not.toHaveBeenCalled();
    expect(m.rolesForIndustry).not.toHaveBeenCalled();
  });

  it('200 with the roles, for the user’s market and language, behind the roles limiter', async () => {
    const roles = [{ title: 'Flight Test Engineer', titleEn: null, source: 'ai', context: 'Flight tests' }];
    m.rolesForIndustry.mockResolvedValue(roles);
    const res = await call('POST', '/roles', { industry: 'aerospace_defense' }, { 'x-robo-locale': 'ko' });
    expect(res).toEqual({ status: 200, body: { roles } });
    expect(m.resolvePrepMarket).toHaveBeenCalledWith({ userId: 'u1', brand: robo, locale: 'ko' });
    expect(m.rolesForIndustry).toHaveBeenCalledWith(expect.objectContaining({ industry: 'aerospace_defense', locale: 'ko', ctx: CTX }));
    expect(limiters.roles).toHaveBeenCalledTimes(1);
  });

  it('503 prep_unavailable when no roles could be written; 500 prep_failed when it throws', async () => {
    m.rolesForIndustry.mockResolvedValue(null);
    expect(await call('POST', '/roles', { industry: 'ai' })).toEqual({ status: 503, body: { error: 'prep_unavailable' } });
    m.rolesForIndustry.mockRejectedValue(new Error('boom'));
    expect(await call('POST', '/roles', { industry: 'ai' })).toEqual({ status: 500, body: { error: 'prep_failed' } });
  });

  it('a closed AI gate answers for itself and nothing is asked of a model', async () => {
    m.brand = go;
    m.gateOpen = false;
    const res = await call('POST', '/roles', { industry: 'ai' });
    expect(res).toEqual({ status: 503, body: { error: 'ai_unavailable', reason: 'ai_consent_required' } });
    expect(m.aiGateOpen).toHaveBeenCalledWith(expect.anything(), expect.anything(), go);
    expect(m.rolesForIndustry).not.toHaveBeenCalled();
  });
});

describe('POST /search', () => {
  it('422 for an empty or overlong query', async () => {
    for (const body of [{}, { query: '   ' }, { query: 'x'.repeat(161) }, { query: 'Engineer', external: 'yes' }]) {
      const res = await call('POST', '/search', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toBe('validation_error');
    }
    expect(m.findJobs).not.toHaveBeenCalled();
  });

  it('200 with the finder’s result; the query, company, industry and external flag pass through', async () => {
    const result = { query: 'AI FDE', understood: { titles: ['Forward Deployed Engineer'], seniority: null, industry: null }, roles: [], postings: [], market: { key: 'us', country: 'US' }, sources: [] };
    m.findJobs.mockResolvedValue(result);
    const res = await call('POST', '/search', { query: '  AI FDE ' });
    expect(res).toEqual({ status: 200, body: result });
    expect(m.findJobs).toHaveBeenCalledWith(
      { userId: 'u1', locale: 'en', query: 'AI FDE', company: null, industry: null, external: undefined, requestId: undefined },
      CTX,
    );
    await call('POST', '/search', { query: 'AI FDE', company: 'Acme', industry: 'ai', external: false });
    expect(m.findJobs).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'Acme', industry: 'ai', external: false }), CTX);
    expect(limiters.search).toHaveBeenCalledTimes(2);
  });

  it('500 prep_failed when the search throws', async () => {
    m.findJobs.mockRejectedValue(new Error('boom'));
    expect(await call('POST', '/search', { query: 'AI FDE' })).toEqual({ status: 500, body: { error: 'prep_failed' } });
  });
});

describe('POST /plan', () => {
  it('422 for a body that names no role, job or post', async () => {
    for (const body of [{}, { role: '' }, { role: '   ', company: 'Acme' }]) {
      const res = await call('POST', '/plan', body);
      expect(res).toEqual({ status: 422, body: { error: 'validation_error', message: 'Name a role, a job or a job post.' } });
    }
    expect(m.aiGateOpen).not.toHaveBeenCalled();
    expect(m.planInterview).not.toHaveBeenCalled();
  });

  it('422 for an invalid field', async () => {
    for (const body of [{ role: 'PM', durationMinutes: 500 }, { role: 'PM', durationMinutes: 'long' }, { posting: { company: 'Acme' } }, { jobId: 'x'.repeat(65) }]) {
      const res = await call('POST', '/plan', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error).toBe('validation_error');
    }
    expect(m.planInterview).not.toHaveBeenCalled();
  });

  it('a long pasted post or a tracking-laden link is accepted (clipped later); only absurd sizes are refused', async () => {
    m.planInterview.mockResolvedValue({ v: 1 });
    const long = { jdText: 'We build payment APIs. '.repeat(1000), posting: { title: 'Backend Engineer', url: `https://jobs.example/1?${'utm=x&'.repeat(300)}` } };
    expect((await call('POST', '/plan', long)).status).toBe(200);
    expect(m.planInterview).toHaveBeenCalledTimes(1);
    const absurd = await call('POST', '/plan', { jdText: 'x'.repeat(60_001) });
    expect(absurd.status).toBe(422);
    expect(m.planInterview).toHaveBeenCalledTimes(1);
  });

  it('200 with the plan; the user, brand, language and cleaned body reach the planner', async () => {
    const plan = { v: 1, role: 'Backend Engineer', fallback: true };
    m.planInterview.mockResolvedValue(plan);
    const res = await call('POST', '/plan', { role: ' Backend Engineer ', company: 'Acme', durationMinutes: 20 }, { 'x-robo-locale': 'de' });
    expect(res).toEqual({ status: 200, body: { plan } });
    expect(m.planInterview).toHaveBeenCalledWith({
      userId: 'u1',
      userName: 'Jane Doe',
      brand: robo,
      locale: 'de',
      body: { role: 'Backend Engineer', company: 'Acme', durationMinutes: 20 },
      requestId: undefined,
    });
    expect(limiters.plan).toHaveBeenCalledTimes(1);
  });

  it('a job the user cannot practise is a 404 job_not_found; any other failure a 500', async () => {
    const { PrepJobNotFoundError } = await import('./planner.js');
    m.planInterview.mockRejectedValue(new PrepJobNotFoundError());
    expect(await call('POST', '/plan', { jobId: 'j_other_market' })).toEqual({ status: 404, body: { error: 'job_not_found' } });
    m.planInterview.mockRejectedValue(new Error('boom'));
    expect(await call('POST', '/plan', { jobId: 'j1' })).toEqual({ status: 500, body: { error: 'prep_failed' } });
  });

  it('GoApply: a closed AI gate stops the plan; the locale is held to the brand’s', async () => {
    m.brand = go;
    m.gateOpen = false;
    expect((await call('POST', '/plan', { role: '产品经理' })).status).toBe(503);
    expect(m.planInterview).not.toHaveBeenCalled();
    m.gateOpen = true;
    m.planInterview.mockResolvedValue({ v: 1 });
    await call('POST', '/plan', { role: '产品经理' }, { 'x-robo-locale': 'ja' });
    expect(m.planInterview).toHaveBeenCalledWith(expect.objectContaining({ brand: go, locale: 'zh' }));
  });

  it('the plan limiter runs before anything else', async () => {
    limiters.plan.mockImplementation((_req: Request, res: Response, _next: NextFunction) => {
      res.status(429).json({ error: 'rate_limited' });
    });
    expect(await call('POST', '/plan', { role: 'PM' })).toEqual({ status: 429, body: { error: 'rate_limited' } });
    expect(m.aiGateOpen).not.toHaveBeenCalled();
    expect(m.planInterview).not.toHaveBeenCalled();
  });
});

describe('default limiters', () => {
  it('each model route gets its own per-user limit when none is injected', async () => {
    const { createPrepRouter } = await import('./routes.js');
    m.rateLimit.mockImplementation(() => pass);
    createPrepRouter({ requireAuth: pass, requireFirstParty: pass });
    expect(m.rateLimit.mock.calls.map(([options]) => [options.name, options.by])).toEqual([
      ['practicePrep_search', 'user'],
      ['practicePrep_roles', 'user'],
      ['practicePrep_plan', 'user'],
    ]);
    for (const [options] of m.rateLimit.mock.calls) expect(options.windows.length).toBeGreaterThan(0);
  });
});
