// @vitest-environment node
//
// POST /v2/resumes/:id/rewrite spends the `rewrite` credit (PRODUCT_PLAN.md §6:
// rewrite = inline AI edits of a bullet, the summary or the skills; 20 a day).
// QA: nine inline rewrites in the editor left the bucket at 0 of 20: the route
// called the model with no credit at all.
//   - one credit per rewrite that came back, committed against the resume;
//   - nothing spent when the rewrite fails (AI off, bad input, not found, model error),
//     nor when the service answers with its canned fallback
//     (resumes.rewriteFallback.test.ts, with the real service);
//   - 402 credits_exhausted in the platform envelope once the day's 20 are used,
//     with no model call;
//   - 503 credits_busy with Retry-After when the credit store is busy (never a
//     bare 500), with no model call;
//   - 403 phone_binding_required for a GoApply WeChat account with no bound
//     phone and 503 ai_unavailable without the AI consent, both before any
//     credit is reserved (the real auth-cn gate over a fake user table).
// Through the real route and the platform credit service (test kit). Faked:
// the rewrite service (no model), auth. No network beyond 127.0.0.1, no database.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const m = vi.hoisted(() => ({
  kit: null as any,
  rewrite: vi.fn(),
  aiAvailable: true,
  /** The account the phone gate reads (auth-cn `phoneBindingRequired`). */
  account: { brand: 'roboapply', phoneE164: null, phoneVerifiedAt: null } as Record<string, unknown>,
  hasWechat: false,
}));

vi.mock('../../../lib/prisma.js', () => ({
  default: { rAResumeVariant: { findFirst: async () => ({ id: 'rv_1', userId: 'u1', name: 'Main', resumeMarkdown: '# A\n## Skills\nSQL, Excel\n', deletedAt: null }) } },
}));
vi.mock('../lib/raAuth.js', () => ({
  requireAuth: (req: Row, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat: vi.fn(), getModel: () => 'test-model' }, LLMService: class {} }));
// The gates in front of the route. The phone gate is the real one (auth-cn
// `requirePhoneBound`) reading a fake user table; the AI consent is a switch.
vi.mock('../../../features/resume/index.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resumeAiAvailable: async () => m.aiAvailable,
}));
vi.mock('../../../features/auth-cn/index.js', async (orig) => {
  const actual = await orig<{ requirePhoneBound: (db?: unknown) => unknown }>();
  const db = {
    user: { findUnique: async () => m.account },
    rAAuthIdentity: { findFirst: async () => (m.hasWechat ? { id: 'ident_1' } : null) },
  };
  return { ...actual, requirePhoneBound: () => actual.requirePhoneBound(db) };
});
// The real module (error classes) with only the service object replaced: every
// answer here is model-written (`agentSucceeded: true`). The real service, with
// a failing model, is driven in resumes.rewriteFallback.test.ts.
vi.mock('../services/RAResumeAIService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  raResumeAIService: {
    rewriteWithSource: async (...args: unknown[]) => ({ result: await m.rewrite(...args), agentSucceeded: true }),
    coachTips: vi.fn(),
  },
}));
vi.mock('../../../platform/credits/index.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    get creditService() {
      return m.kit.credits;
    },
  };
});
vi.mock('../../../features/compliance/index.js', () => ({ registerArtifactStorageDeleter: vi.fn(), complianceService: {} }));
vi.mock('../../services/SeekerAccountPurgeService.js', () => ({ setArtifactStorageDeleter: vi.fn() }));
vi.mock('../../../lib/candidateResumeIngest.js', () => ({
  isAcceptedResumeUpload: () => true,
  readCandidateResumeOriginal: vi.fn(),
  ingestCandidateResume: vi.fn(),
  CandidateResumeIngestError: class extends Error {},
}));

import { runWithBrand } from '../../../lib/requestContext.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { CreditStoreBusyError } from '../../../platform/credits/errors.js';
import * as ai from '../services/RAResumeAIService.js';

let server: Server;
let base: string;

beforeAll(async () => {
  m.kit = createCreditTestKit();
  const express = (await import('express')).default;
  const router = ((await import('./resumes.js')) as { default: import('express').Router }).default;
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithBrand('roboapply', next));
  app.use('/resumes', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resumes`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  m.kit.store.ledger.length = 0;
  m.kit.store.windows.length = 0;
  m.rewrite.mockReset().mockResolvedValue({ rewrite: 'Built a weekly on-time delivery dashboard.' });
  m.aiAvailable = true;
  m.account = { brand: 'roboapply', phoneE164: null, phoneVerifiedAt: null };
  m.hasWechat = false;
});

const post = async (body: Row, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/rv_1/rewrite`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (text.startsWith('<')) throw new Error(text.replace(/<[^>]+>/g, ' ').slice(0, 600));
  return { status: res.status, body: text ? (JSON.parse(text) as Row) : null, headers: res.headers };
};
const BODY = { mode: 'bullet', action: 'improve', text: 'Worked on dashboards.' };
const rows = (status?: string) => (m.kit.store.ledger as Row[]).filter((r) => r.bucket === 'rewrite' && (!status || r.status === status));
const usage = async () => (await m.kit.credits.usage('u1')).find((u: Row) => u.bucket === 'rewrite') as Row;

describe('POST /v2/resumes/:id/rewrite spends the rewrite credit', () => {
  it('one credit per rewrite, committed against the resume', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    // The model wrote it, so it is charged and says so (`source`, additive).
    expect(res.body).toEqual({ rewrite: 'Built a weekly on-time delivery dashboard.', source: 'model' });
    expect(rows('committed')).toHaveLength(1);
    expect(rows('committed')[0]).toMatchObject({ userId: 'u1', amount: 1, refType: 'resume_inline_rewrite', refId: 'rv_1' });

    m.rewrite.mockResolvedValueOnce({ options: [{ label: 'Tight', text: 'Analyst who builds delivery dashboards.' }] });
    expect((await post({ mode: 'summary', text: 'Analyst.' })).status).toBe(200);
    m.rewrite.mockResolvedValueOnce({ skills: ['SQL', 'Excel', 'Tableau'] });
    expect((await post({ mode: 'skills' })).status).toBe(200);
    expect(rows('committed')).toHaveLength(3);
    expect((await usage()).used).toBe(3);
    expect(m.rewrite).toHaveBeenCalledTimes(3);
  });

  it('a failed rewrite costs nothing: AI off, bad input, not found, model error', async () => {
    const cases: Array<[Error, number]> = [
      [new ai.AiUnavailableError('off'), 503],
      [new ai.RewriteValidationError('text is required'), 422],
      [new ai.ResumeNotFoundError('nope'), 404],
      [new Error('provider down'), 500],
    ];
    for (const [error, status] of cases) {
      m.rewrite.mockRejectedValueOnce(error);
      const res = await post(BODY);
      expect(res.status, error.constructor.name).toBe(status);
    }
    expect(rows('committed')).toHaveLength(0);
    const u = await usage();
    expect([u.used, u.reserved]).toEqual([0, 0]);
  });

  it('402 credits_exhausted once the allowance is used, and the model is not called', async () => {
    const cap = (await usage()).cap as number;
    expect(cap).toBeGreaterThan(0);
    for (let i = 0; i < cap; i += 1) expect((await post(BODY)).status).toBe(200);
    m.rewrite.mockClear();
    const res = await post(BODY);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: 'credits_exhausted', details: { bucket: 'rewrite' } });
    expect(m.rewrite).not.toHaveBeenCalled();
    expect(rows('committed')).toHaveLength(cap);
  });

  // Wave FIX gate: the reserve can fail because the credit store is busy (FIX-9 `CreditStoreBusyError`).
  // This route's own catch answered that as a bare `500 { error: 'internal_error' }`.
  it('503 credits_busy with Retry-After when the credit store is busy: no bare 500, nothing spent, the model is not called', async () => {
    const busy = vi.spyOn(m.kit.credits, 'withCredit').mockRejectedValueOnce(new CreditStoreBusyError({ cause: new Error('P2028 transaction timeout') }));
    try {
      const res = await post(BODY);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(res.body).toEqual({
        success: false,
        code: 'credits_busy',
        error: 'We could not start this right now. Try again in a moment.',
        details: { retryAfterSec: 5 },
      });
      expect(JSON.stringify(res.body)).not.toContain('P2028');
    } finally {
      busy.mockRestore();
    }
    expect(m.rewrite).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    // The same request works once the store answers.
    expect((await post(BODY)).status).toBe(200);
    expect(rows('committed')).toHaveLength(1);
  });

  // Wave FIX gate: the route was mounted with `requireAuth` only, so a GoApply account that signed in
  // with WeChat and never bound a phone could run the rewrite model from the editor (WP-11).
  it('403 phone_binding_required for a GoApply WeChat account with no bound phone: no reservation, no model call', async () => {
    m.account = { brand: 'goapply', phoneE164: null, phoneVerifiedAt: null };
    m.hasWechat = true;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'phone_binding_required', details: { bindRoute: '/bind-phone' } });
    expect(m.rewrite).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    const u = await usage();
    expect([u.used, u.reserved]).toEqual([0, 0]);

    // Once the phone is bound the same account may rewrite; a GoApply phone account was never held.
    m.account = { brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date('2026-10-10T00:00:00Z') };
    expect((await post(BODY)).status).toBe(200);
    m.account = { brand: 'goapply', phoneE164: null, phoneVerifiedAt: null };
    m.hasWechat = false;
    expect((await post(BODY)).status).toBe(200);
    expect(rows('committed')).toHaveLength(2);
  });

  it('503 ai_unavailable without the AI consent, before any credit is reserved', async () => {
    m.aiAvailable = false;
    const res = await post(BODY);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'ai_unavailable', code: 'ai_unavailable' });
    expect(m.rewrite).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('a replayed Idempotency-Key never buys a second rewrite', async () => {
    expect((await post(BODY, { 'Idempotency-Key': 'same-key' })).status).toBe(200);
    const again = await post(BODY, { 'Idempotency-Key': 'same-key' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ success: false, code: 'conflict', details: { reason: 'request_already_completed' } });
    expect(rows('committed')).toHaveLength(1);
    expect(m.rewrite).toHaveBeenCalledTimes(1);
  });
});
