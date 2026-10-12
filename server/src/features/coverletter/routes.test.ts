// @vitest-environment node
//
// WP-37 route tests: every cover-letter route answers through the platform
// envelope — auth (401), validation (422), ownership (404), credits (402), AI
// consent (503, zero model calls), the GoApply phone gate (403), the rewrite
// limit (429) — and the export streams a labelled file.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createCoverLetterRouter } from './routes.js';
import { FIXTURE_USER as U, createFixture } from './fixtures.js';
import type { CoverLetterView, ListLettersResponse } from './contract.js';

const BASE = '/api/v1/roboapply/cover-letters';
type Env<T> = { success: boolean; data: T; code?: string; details?: Record<string, unknown> };

let h: RouteHarness;
let ai = true;
let phoneBound = true;
const kit = createCreditTestKit({ now: new Date('2026-10-10T12:00:00Z') });
const write = vi.fn();
const f = createFixture({ credits: kit.credits, ai: () => ai, rewriteLimit: 1, write: (...a) => write(...a) });
const phoneGate: RequestHandler = (_req, res, next) => {
  if (phoneBound) return next();
  res.status(403).json({ success: false, code: 'phone_binding_required', error: 'Bind a phone first.' });
};

beforeAll(async () => {
  const { CLEAN_LETTER } = await import('./fixtures.js');
  write.mockImplementation(async () => structuredClone(CLEAN_LETTER));
  h = await startRouteHarness({
    mounts: [[BASE, createCoverLetterRouter({ seekerAuth: [fakeAuth((req) => (req.headers['x-test-anon'] ? null : { id: U }))] }, { service: f.service, phoneGate })]],
  });
});
afterAll(async () => {
  await h.close();
});

describe('cover letter routes', () => {
  let letter: CoverLetterView;

  it('401 without a session', async () => {
    const res = await h.request('GET', BASE, { headers: { 'x-test-anon': '1' } });
    expect(res.status).toBe(401);
    const post = await h.request('POST', BASE, { headers: { 'x-test-anon': '1' }, body: { jobId: 'job_1', resumeVariantId: 'rv_1' } });
    expect(post.status).toBe(401);
  });

  it('POST / → 201 with a cited letter', async () => {
    const res = await h.request<Env<CoverLetterView>>('POST', BASE, { body: { jobId: 'job_1', resumeVariantId: 'rv_1', tone: 'formal' }, headers: { 'Idempotency-Key': 'c1' } });
    expect(res.status).toBe(201);
    letter = res.body.data;
    expect(letter.tone).toBe('formal');
    expect(letter.sentences.length).toBeGreaterThan(0);
  });

  it('422 on an invalid body (both jobId and jd, unknown tone)', async () => {
    const both = await h.request<Env<unknown>>('POST', BASE, {
      body: { jobId: 'job_1', jd: { title: 'X', company: 'Y', text: 'x'.repeat(60) }, resumeVariantId: 'rv_1' },
    });
    expect(both.status).toBe(422);
    const tone = await h.request<Env<unknown>>('POST', BASE, { body: { jobId: 'job_1', resumeVariantId: 'rv_1', tone: 'cheeky' } });
    expect(tone.status).toBe(422);
    expect(tone.body.code).toBe('invalid_request');
  });

  it('GET / lists; GET /:id reads; 404 for an unknown letter', async () => {
    const list = await h.request<Env<ListLettersResponse>>('GET', `${BASE}?jobId=job_1`);
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i) => i.id)).toContain(letter.id);
    const one = await h.request<Env<CoverLetterView>>('GET', `${BASE}/${letter.id}`);
    expect(one.body.data.id).toBe(letter.id);
    const missing = await h.request<Env<unknown>>('GET', `${BASE}/nope`);
    expect(missing.status).toBe(404);
  });

  it('PATCH /:id saves an edit; attach to another user’s application is 404', async () => {
    const res = await h.request<Env<CoverLetterView>>('PATCH', `${BASE}/${letter.id}`, { body: { bodyMarkdown: `${letter.bodyMarkdown}\n\nP.S. I can start in May.` } });
    expect(res.status).toBe(200);
    expect(res.body.data.userEdited).toBe(true);
    const bad = await h.request<Env<unknown>>('PATCH', `${BASE}/${letter.id}`, { body: { trackerEntryId: 'te_other' } });
    expect(bad.status).toBe(404);
  });

  it('POST /:id/rewrite → new version; the second today is 429 with Retry-After', async () => {
    const ok = await h.request<Env<CoverLetterView>>('POST', `${BASE}/${letter.id}/rewrite`, { body: { instruction: 'Make it shorter' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.versions.at(-1)!.reason).toBe('rewrite');
    const limited = await h.request<Env<unknown>>('POST', `${BASE}/${letter.id}/rewrite`, { body: { instruction: 'Again' } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3600');
    expect(limited.body.details).toMatchObject({ reason: 'cover_letter_rewrite_limit' });
  });

  it('POST /:id/restore', async () => {
    const res = await h.request<Env<CoverLetterView>>('POST', `${BASE}/${letter.id}/restore`, { body: { versionIndex: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.data.bodyMarkdown).toBe(letter.bodyMarkdown);
  });

  it('402 credits_exhausted once the day’s letters are used (no model call)', async () => {
    await h.request('POST', `${BASE}/${letter.id}/regenerate`, { body: { tone: 'warm' }, headers: { 'Idempotency-Key': 'r1' } });
    write.mockClear();
    const res = await h.request<Env<unknown>>('POST', BASE, { body: { jobId: 'job_1', resumeVariantId: 'rv_1' }, headers: { 'Idempotency-Key': 'c3' } });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('credits_exhausted');
    expect(res.body.details).toMatchObject({ bucket: 'cover_letter' });
    expect(write).not.toHaveBeenCalled();
  });

  it('503 ai_unavailable without AI consent; reading and editing still work', async () => {
    ai = false;
    write.mockClear();
    const res = await h.request<Env<unknown>>('POST', `${BASE}/${letter.id}/rewrite`, { body: { instruction: 'Shorter' } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ai_unavailable');
    const read = await h.request<Env<CoverLetterView>>('GET', `${BASE}/${letter.id}`);
    expect(read.body.data.aiAvailable).toBe(false);
    expect(write).not.toHaveBeenCalled();
    ai = true;
  });

  it('403 phone_binding_required on the AI routes for an unbound GoApply WeChat account', async () => {
    phoneBound = false;
    const res = await h.request<Env<unknown>>('POST', BASE, { body: { jobId: 'job_1', resumeVariantId: 'rv_1' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('phone_binding_required');
    const read = await h.request('GET', `${BASE}/${letter.id}`);
    expect(read.status).toBe(200);
    phoneBound = true;
  });

  it('GET /:id/export streams the file with a download name', async () => {
    const attached = await h.request<Env<CoverLetterView>>('PATCH', `${BASE}/${letter.id}`, { body: { trackerEntryId: 'te_1' } });
    expect(attached.body.data.trackerEntryId).toBe('te_1');
    const res = await h.request('GET', `${BASE}/${letter.id}/export?format=pdf&trackerEntryId=te_1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Cover letter - Senior Backend Engineer _ Stripe\.pdf"/);
    expect(res.text.startsWith('%PDF-')).toBe(true);
    expect(f.store.artifacts).toHaveLength(1);
    const bad = await h.request<Env<unknown>>('GET', `${BASE}/${letter.id}/export?format=rtf`);
    expect(bad.status).toBe(422);
  });

  it('DELETE /:id', async () => {
    const res = await h.request<Env<{ deleted: boolean }>>('DELETE', `${BASE}/${letter.id}`);
    expect(res.body.data).toEqual({ deleted: true });
    expect((await h.request('GET', `${BASE}/${letter.id}`)).status).toBe(404);
  });
});

describe('default wiring with AI consent off', () => {
  it('makes zero LLMService calls and spends nothing', async () => {
    vi.resetModules();
    vi.doMock('../../platform/consent/aiAllowed.js', () => ({ aiAllowed: async () => false }));
    const { llmService } = await import('../../services/llm/LLMService.js');
    const chat = vi.spyOn(llmService, 'chat');
    const { getCoverLetterService } = await import('./index.js');
    const svc = await getCoverLetterService();
    await expect(svc.create('u_off', { jobId: 'job_1', resumeVariantId: 'rv_1' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    await expect(svc.rewrite('u_off', 'cl_1', 'Shorter')).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(chat).not.toHaveBeenCalled();
    vi.doUnmock('../../platform/consent/aiAllowed.js');
  });
});
