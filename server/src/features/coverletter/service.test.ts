// @vitest-environment node
//
// WP-37 cover-letter service: credits, AI gate (zero model calls), the claim
// checker's retry and rejection, versions, rewrite limit, restore, attach to
// an application, export with the AI label, and the GoApply label log.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { HttpError } from '../../platform/http.js';
import { ContentBlockedError } from '../../platform/llm/contentSafety/types.js';
import { CLEAN_LETTER, FIXTURE_USER as U, POSTING_AS_EXPERIENCE_LETTER, createFixture } from './fixtures.js';
import type { WriterOutput } from './CoverLetterAgent.js';
import { providerOf, restoreUserTokens, tokenizeUserSentences } from './service.js';
import { cjkFontsFor } from './letterExport.js';
import { createPrismaPostingStore, parseStoredPosting, type PostingDb } from './store.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const now = () => NOW;
const used = async (kit: ReturnType<typeof createCreditTestKit>) => (await kit.credits.usage(U)).find((b) => b.bucket === 'cover_letter')!;
const clean = async () => structuredClone(CLEAN_LETTER);

async function expectHttp(p: Promise<unknown>, code: string, reason?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe(code);
  if (reason) expect((err as HttpError).details).toMatchObject({ reason });
  return err as HttpError;
}

describe('create', () => {
  it('writes a cited letter, spends one cover_letter credit, signs it after the model ran', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, now });
    const view = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', tone: 'warm' }, { idempotencyKey: 'k1', requestLocale: 'en' });

    expect(view.title).toBe('Senior Backend Engineer · Stripe');
    expect(view.tone).toBe('warm');
    expect(view.aiWritten).toBe(true);
    expect(view.bodyMarkdown.endsWith('Sincerely,\nSam Lee')).toBe(true);
    expect(view.sentences).toHaveLength(4);
    expect(view.sentences.every((s) => s.sources.length > 0 && s.sources.every((x) => x.source === 'resume' || x.source === 'posting'))).toBe(true);
    expect(view.versions).toEqual([expect.objectContaining({ index: 0, reason: 'generated', current: true })]);
    expect((await used(kit)).used).toBe(1);

    // No name, email or phone in the prompt.
    const prompt = JSON.stringify(f.writerInputs[0]);
    expect(prompt).not.toMatch(/Sam Lee|sam\.lee@example\.test|555 0100/);
    expect(f.writerInputs[0]!.profileText).toBe('Target role: Backend engineer');
  });

  it('with AI off: 503 ai_unavailable, zero model calls, no credit', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const write = vi.fn(clean);
    const factCheck = vi.fn(async () => ({ passed: true, violations: [] }));
    const f = createFixture({ credits: kit.credits, ai: () => false, write, factCheck, now });
    await expectHttp(f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }), 'ai_unavailable');
    await expectHttp(f.service.rewrite(U, 'cl_x', 'Shorter'), 'ai_unavailable');
    await expectHttp(f.service.regenerate(U, 'cl_x', {}), 'ai_unavailable');
    expect(write).not.toHaveBeenCalled();
    expect(factCheck).not.toHaveBeenCalled();
    expect((await used(kit)).used).toBe(0);
  });

  it('retries once with the problems called out, then saves the clean letter', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const write = vi.fn<(...a: unknown[]) => Promise<WriterOutput>>().mockResolvedValueOnce(structuredClone(POSTING_AS_EXPERIENCE_LETTER)).mockImplementation(clean);
    const f = createFixture({ credits: kit.credits, write, now });
    const view = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(f.writerInputs[1]!.retryNote).toMatch(/JOB POST as the candidate's own experience/);
    expect(view.bodyMarkdown).not.toMatch(/Kubernetes/);
  });

  it('rejects a letter that keeps writing job-post facts as experience: 409, credit released', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const write = vi.fn(async () => structuredClone(POSTING_AS_EXPERIENCE_LETTER));
    const f = createFixture({ credits: kit.credits, write, now });
    await expectHttp(f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }), 'conflict', 'cover_letter_claim_rejected');
    expect(write).toHaveBeenCalledTimes(2);
    expect(f.store.letters.size).toBe(0);
    const b = await used(kit);
    expect([b.used, b.reserved]).toEqual([0, 0]);
  });

  it('the fact-checker’s violations also trigger the retry; a checker that cannot run fails closed', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const factCheck = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, violations: [{ sentence: 2, claim: 'led a migration', severity: 'mismatch', originalSupport: 'NONE' }] })
      .mockResolvedValueOnce({ passed: true, violations: [] });
    const f = createFixture({ credits: kit.credits, factCheck, now });
    await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    expect(f.writerInputs[1]!.retryNote).toMatch(/\[mismatch\] "led a migration"/);

    const broken = createFixture({ credits: kit.credits, factCheck: async () => Promise.reject(new Error('timeout')), now });
    await expectHttp(broken.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }), 'ai_unavailable', 'fact_check_failed');
  });

  it('content_blocked passes through untouched and is never retried', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const write = vi.fn(async () => Promise.reject(new ContentBlockedError('output', ['politics'])));
    const f = createFixture({ credits: kit.credits, write, now });
    const err = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContentBlockedError);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await used(kit)).used).toBe(0);
  });

  it('refuses a resume with lines still to verify, an unknown job, and another user’s application', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, unverified: 2, now });
    await expectHttp(f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }), 'conflict', 'resume_unverified_claims');
    const g = createFixture({ credits: kit.credits, now });
    await expectHttp(g.service.create(U, { jobId: 'nope', resumeVariantId: 'rv_1' }), 'not_found', 'job_not_found');
    await expectHttp(g.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', trackerEntryId: 'te_other' }), 'not_found', 'tracker_entry_not_found');
    await expectHttp(g.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_nope' }), 'not_found');
  });

  it('a third letter on a free day is 402 credits_exhausted before any model call', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const write = vi.fn(clean);
    const f = createFixture({ credits: kit.credits, write, now });
    await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }, { idempotencyKey: 'a' });
    await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }, { idempotencyKey: 'b' });
    write.mockClear();
    const err = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }, { idempotencyKey: 'c' }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('credits_exhausted');
    expect(write).not.toHaveBeenCalled();
  });

  it('attaches to the application when asked', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, now });
    const view = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', trackerEntryId: 'te_1' });
    expect(view.trackerEntryId).toBe('te_1');
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBe(view.id);
  });

  it('GoApply: writes an AI content label row for the generated letter', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, market: 'cn', now });
    const view = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', locale: 'zh' }, {});
    expect(f.labelLogs).toEqual([expect.objectContaining({ kind: 'cover_letter', artifactId: view.id, provider: 'openai' })]);
    expect(view.locale).toBe('zh');
  });

  it('seam default: with no locale from the caller or the request, GoApply writes in Chinese and RoboApply in English', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const cn = createFixture({ credits: kit.credits, market: 'cn', now });
    // coverLetterService.createLetter (WP-50/52) passes neither input.locale nor a request locale.
    expect((await cn.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }, { idempotencyKey: 'seam-cn' })).locale).toBe('zh');
    expect(cn.writerInputs[0]!.locale).toBe('zh');
    const intl = createFixture({ credits: createCreditTestKit({ now: NOW }).credits, now });
    expect((await intl.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' }, { idempotencyKey: 'seam-intl' })).locale).toBe('en');
    // An explicit choice still wins (GoApply letter in English for a foreign company).
    const en = await cn.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', locale: 'en' }, { idempotencyKey: 'seam-cn-en' });
    expect(en.locale).toBe('en');
  });
});

describe('edit, versions, rewrite, restore', () => {
  async function setup(options: Partial<Parameters<typeof createFixture>[0]> = {}) {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, now, ...options });
    const letter = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    return { kit, f, letter };
  }

  it('PATCH snapshots an edit version and marks the new sentence as the user’s', async () => {
    const { f, letter } = await setup();
    const body = letter.bodyMarkdown.replace('Sincerely,', 'I also mentor new engineers every week.\n\nSincerely,');
    const v = await f.service.patch(U, letter.id, { bodyMarkdown: body });
    expect(v.userEdited).toBe(true);
    expect(v.sentences.find((s) => s.text === 'I also mentor new engineers every week.')!.sources).toEqual([{ source: 'user', ref: '' }]);
    expect(v.versions.map((x) => x.reason)).toEqual(['generated', 'edit']);
    const again = await f.service.patch(U, letter.id, { bodyMarkdown: `${body}\n` });
    expect(again.versions.map((x) => x.reason)).toEqual(['generated', 'edit']);
  });

  it('rewrite: no credit, counts against 20/day, keeps the user’s own sentence', async () => {
    const mine = 'I also mentor new engineers every week.';
    const write = vi.fn(async (input: { mode: string }) => {
      const out = structuredClone(CLEAN_LETTER);
      if (input.mode === 'rewrite') {
        out.paragraphs[1]!.push({ text: mine, kind: 'other', cites: [{ source: 'letter', quote: mine }] });
        out.paragraphs[0]![1]!.cites = [{ source: 'letter', quote: out.paragraphs[0]![1]!.text }];
      }
      return out;
    });
    const { kit, f, letter } = await setup({ write: write as never, rewriteLimit: 1 });
    await f.service.patch(U, letter.id, { bodyMarkdown: letter.bodyMarkdown.replace('Sincerely,', `${mine}\n\nSincerely,`) });
    const v = await f.service.rewrite(U, letter.id, 'Make the opening stronger');
    expect(v.versions.map((x) => x.reason)).toEqual(['generated', 'edit', 'rewrite']);
    expect(v.sentences.find((s) => s.text === mine)!.sources).toEqual([{ source: 'user', ref: '' }]);
    // A `letter` cite of an AI sentence inherits that sentence's resume citation.
    expect(v.sentences.find((s) => s.text.startsWith('At Acme Pay'))!.sources[0]!.source).toBe('resume');
    expect(v.rewritesLeftToday).toBe(0);
    expect(f.writerInputs[1]!.instruction).toBe('Make the opening stronger');
    expect(f.writerInputs[1]!.currentLetter).not.toMatch(/Sam Lee/);
    // The user's own sentence reaches the model only as a token.
    expect(f.writerInputs[1]!.currentLetter).toContain('[[USER_1]]');
    expect(f.writerInputs[1]!.currentLetter).not.toContain(mine);
    expect((await used(kit)).used).toBe(1);
    const limited = await expectHttp(f.service.rewrite(U, letter.id, 'Again'), 'rate_limited', 'cover_letter_rewrite_limit');
    expect(limited.headers?.['Retry-After']).toBe('3600');
  });

  it('rewrite keeps a contact line the user wrote: the model sees a token, the line comes back exactly', async () => {
    const mine = 'Email me at sam.lee@example.test.';
    const write = vi.fn(async (input: { mode: string; currentLetter?: string }) => {
      const out = structuredClone(CLEAN_LETTER);
      if (input.mode === 'rewrite') {
        const token = /\[\[USER_\d+\]\]/.exec(input.currentLetter ?? '')![0];
        out.paragraphs[1]!.push({ text: token, kind: 'other', cites: [{ source: 'letter', quote: token }] });
      }
      return out;
    });
    const { f, letter } = await setup({ write: write as never });
    await f.service.patch(U, letter.id, { bodyMarkdown: letter.bodyMarkdown.replace('Sincerely,', `${mine}\n\nSincerely,`) });
    const v = await f.service.rewrite(U, letter.id, 'Make it shorter');
    const prompt = f.writerInputs.at(-1)!.currentLetter!;
    expect(prompt).not.toMatch(/sam\.lee@example\.test|\[email\]/);
    expect(v.bodyMarkdown).toContain(mine);
    expect(v.sentences.find((s) => s.text === mine)!.sources).toEqual([{ source: 'user', ref: '' }]);
    expect(v.versions.at(-1)!.reason).toBe('rewrite');
    expect(f.rewritesUsed.get(letter.id)).toBe(1);
  });

  it('user tokens: replaced whole, restored exactly, unknown tokens dropped', () => {
    const { text, tokens } = tokenizeUserSentences('Hi.\n\nCall me. I like Go.\n\nCall me. Bye', ['Call me.', 'Nope.']);
    expect(text).toBe('Hi.\n\n[[USER_1]] I like Go.\n\n[[USER_1]] Bye');
    expect(restoreUserTokens('[[USER_1]]', tokens)).toBe('Call me.');
    expect(restoreUserTokens('[[USER_9]]', tokens)).toBe('');
  });

  it('a failed or rejected rewrite does not use one of today’s rewrites', async () => {
    let failRewrite: 'error' | 'reject' | null = 'error';
    const write = vi.fn(async (input: { mode: string }) => {
      if (input.mode === 'rewrite' && failRewrite === 'error') throw new Error('upstream 500');
      if (input.mode === 'rewrite' && failRewrite === 'reject') return structuredClone(POSTING_AS_EXPERIENCE_LETTER);
      return structuredClone(CLEAN_LETTER);
    });
    const { f, letter } = await setup({ write: write as never, rewriteLimit: 1 });
    await expectHttp(f.service.rewrite(U, letter.id, 'Shorter'), 'ai_unavailable', 'writer_failed');
    failRewrite = 'reject';
    await expectHttp(f.service.rewrite(U, letter.id, 'Shorter'), 'conflict', 'cover_letter_claim_rejected');
    expect(f.rewritesUsed.get(letter.id) ?? 0).toBe(0);
    failRewrite = null;
    const v = await f.service.rewrite(U, letter.id, 'Shorter');
    expect(v.rewritesLeftToday).toBe(0);
    const limited = await expectHttp(f.service.rewrite(U, letter.id, 'Again'), 'rate_limited', 'cover_letter_rewrite_limit');
    expect(limited.headers?.['Retry-After']).toBe('3600');
    expect(write.mock.calls.filter(([i]) => (i as { mode: string }).mode === 'rewrite')).toHaveLength(4); // 1 failed + 2 rejected + 1 ok; none after the limit
  });

  it('regenerate: new tone, one more credit, new version', async () => {
    const { kit, f, letter } = await setup();
    const v = await f.service.regenerate(U, letter.id, { tone: 'formal', length: 'short' }, { idempotencyKey: 'rg' });
    expect([v.tone, v.length]).toEqual(['formal', 'short']);
    expect(v.versions.map((x) => x.reason)).toEqual(['generated', 'regenerate']);
    expect((await used(kit)).used).toBe(2);
  });

  it('restore brings back a version (with its citations) as a new version', async () => {
    const { f, letter } = await setup();
    await f.service.patch(U, letter.id, { bodyMarkdown: 'Hello.\n\nI wrote this myself.' });
    const v = await f.service.restore(U, letter.id, 0);
    expect(v.bodyMarkdown).toBe(letter.bodyMarkdown);
    expect(v.userEdited).toBe(false);
    expect(v.versions.map((x) => [x.reason, x.current])).toEqual([
      ['generated', false],
      ['edit', false],
      ['restore', true],
    ]);
    await expectHttp(f.service.restore(U, letter.id, 7), 'not_found', 'cover_letter_version_not_found');
  });

  it('attach / detach keeps the application link in sync; delete clears it', async () => {
    const { f, letter } = await setup();
    await f.service.attach(U, letter.id, 'te_1');
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBe(letter.id);
    await expectHttp(f.service.attach(U, letter.id, 'te_other'), 'not_found', 'tracker_entry_not_found');
    await f.service.attach(U, letter.id, null);
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBeNull();
    await f.service.attach(U, letter.id, 'te_1');
    expect(await f.service.remove(U, letter.id)).toEqual({ deleted: true });
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBeNull();
    await expectHttp(f.service.get(U, letter.id), 'not_found');
  });

  it('attaching a second letter to an application detaches the first; the first then records no file for it', async () => {
    const { kit, f, letter: a } = await setup();
    const b = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    await f.service.attach(U, a.id, 'te_1');
    expect((await f.service.attach(U, b.id, 'te_1')).trackerEntryId).toBe('te_1');
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBe(b.id);
    expect((await f.service.get(U, a.id)).trackerEntryId).toBeNull();
    // A stale link (an old tab) still cannot log A as sent with te_1.
    await f.service.exportFile(U, a.id, { format: 'docx', trackerEntryId: 'te_1' });
    expect(f.store.artifacts).toHaveLength(0);
    await f.service.exportFile(U, b.id, { format: 'docx', trackerEntryId: 'te_1' });
    expect(f.store.artifacts).toEqual([expect.objectContaining({ coverLetterId: b.id, trackerEntryId: 'te_1' })]);
    // Writing a new letter straight onto the application detaches B too (next day: the free plan writes 2 a day).
    kit.setNow(new Date('2026-10-11T12:00:00Z'));
    const c = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', trackerEntryId: 'te_1' });
    expect((await f.service.get(U, b.id)).trackerEntryId).toBeNull();
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBe(c.id);
  });

  it('delete clears the application link', async () => {
    const { f, letter } = await setup();
    await f.service.attach(U, letter.id, 'te_1');
    expect(await f.service.remove(U, letter.id)).toEqual({ deleted: true });
    expect(f.store.trackerEntries.get('te_1')!.coverLetterId).toBeNull();
    await expectHttp(f.service.get(U, letter.id), 'not_found');
  });

  it('a pasted post is kept for rewrites (SR-37-1); without it the rewrite says so', async () => {
    const jd = { title: 'Data Analyst', company: 'Initech', text: 'We need SQL reports for the finance team every week, and you will own the dashboards.' };
    const jdLetter = async (input: { job: { company: string } }): Promise<WriterOutput> => {
      if (input.job.company !== 'Initech') return structuredClone(CLEAN_LETTER);
      return {
        greeting: 'Dear Hiring Manager,',
        paragraphs: [
          [
            { text: 'Your team needs weekly SQL reports for finance.', kind: 'company', cites: [{ source: 'posting', quote: 'We need SQL reports for the finance team every week' }] },
            { text: 'I wrote billing jobs in Go and Python.', kind: 'experience', cites: [{ source: 'resume', quote: 'Wrote billing jobs in Go and Python.' }] },
          ],
        ],
        closing: 'Sincerely,',
      };
    };
    const { f } = await setup({ write: jdLetter as never });
    const letter = await f.service.create(U, { jd, resumeVariantId: 'rv_1' });
    expect(letter.jobId).toBeNull();
    expect(letter.postingAvailable).toBe(true);
    expect(f.postings.get(letter.id)).toEqual(jd);
    await f.service.rewrite(U, letter.id, 'Shorter');
    expect(f.writerInputs.at(-1)!.job.company).toBe('Initech');

    const { f: g, kit: gKit } = await setup({ keepPostings: false, write: jdLetter as never });
    // A letter whose post was not kept (written before the column existed): the view says rewriting is not possible.
    const other = await g.service.create(U, { jd, resumeVariantId: 'rv_1' });
    expect(other.postingAvailable).toBe(false);
    expect((await g.service.get(U, other.id)).postingAvailable).toBe(false);
    gKit.setNow(new Date('2026-10-11T12:00:00Z'));
    const fromJob = await g.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    expect(fromJob.postingAvailable).toBe(true);
    await expectHttp(g.service.rewrite(U, other.id, 'Shorter'), 'conflict', 'posting_unavailable');
    await expectHttp(g.service.regenerate(U, other.id, {}), 'conflict', 'posting_unavailable');
    expect(g.rewritesUsed.get(other.id) ?? 0).toBe(0);
  });
  it('SR-37-1: the Prisma store persists RACoverLetter.postingSnapshot, so a pasted-post letter can be rewritten', async () => {
    const jd = { title: 'Data Analyst', company: 'Initech', text: 'We need SQL reports for the finance team every week, and you will own the dashboards.' };
    const jdLetter = async (input: { job: { company: string; text: string } }): Promise<WriterOutput> =>
      input.job.company !== 'Initech'
        ? structuredClone(CLEAN_LETTER)
        : {
            greeting: 'Dear Hiring Manager,',
            paragraphs: [
              [
                { text: 'Your team needs weekly SQL reports for finance.', kind: 'company', cites: [{ source: 'posting', quote: 'We need SQL reports for the finance team every week' }] },
                { text: 'I wrote billing jobs in Go and Python.', kind: 'experience', cites: [{ source: 'resume', quote: 'Wrote billing jobs in Go and Python.' }] },
              ],
            ],
            closing: 'Sincerely,',
          };
    // The Prisma posting adapter over a table that records what it is asked.
    const column = new Map<string, unknown>();
    const calls: Array<{ op: string; args: unknown }> = [];
    const db: PostingDb = {
      rACoverLetter: {
        findFirst: async (args) => {
          calls.push({ op: 'findFirst', args });
          return column.has(args.where.id) ? { postingSnapshot: column.get(args.where.id) } : { postingSnapshot: null };
        },
        updateMany: async (args) => {
          calls.push({ op: 'updateMany', args });
          column.set(args.where.id, args.data.postingSnapshot);
          return { count: 1 };
        },
      },
    };
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, now, write: jdLetter as never, postings: createPrismaPostingStore(async () => db) });

    const letter = await f.service.create(U, { jd, resumeVariantId: 'rv_1' });
    // Written to the column of that letter, as { title, company, text }.
    expect(calls.find((c) => c.op === 'updateMany')!.args).toEqual({ where: { id: letter.id, deletedAt: null }, data: { postingSnapshot: jd } });
    expect(column.get(letter.id)).toEqual(jd);
    expect(letter.postingAvailable).toBe(true);

    // Read back for a rewrite and a regenerate: the model gets the same post again.
    expect((await f.service.get(U, letter.id)).postingAvailable).toBe(true);
    await f.service.rewrite(U, letter.id, 'Shorter');
    expect(f.writerInputs.at(-1)!.job).toMatchObject({ title: 'Data Analyst', company: 'Initech' });
    expect(f.writerInputs.at(-1)!.job.text).toContain('SQL reports for the finance team');
    await f.service.regenerate(U, letter.id, {});
    expect(f.writerInputs.at(-1)!.job.company).toBe('Initech');

    // A letter written from a job id stores no snapshot (the post is re-read from the job).
    kit.setNow(new Date('2026-10-11T12:00:00Z'));
    const fromJob = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    expect(column.has(fromJob.id)).toBe(false);
    expect(fromJob.postingAvailable).toBe(true);
  });

  it('SR-37-1: an empty or malformed column reads as "post not kept"', async () => {
    expect(parseStoredPosting(null)).toBeNull();
    expect(parseStoredPosting('text')).toBeNull();
    expect(parseStoredPosting([])).toBeNull();
    expect(parseStoredPosting({ title: 'A', text: '   ' })).toBeNull();
    expect(parseStoredPosting({ title: 'A', text: 'Posting text' })).toEqual({ title: 'A', company: '', text: 'Posting text' });
    const db: PostingDb = { rACoverLetter: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) } };
    await expect(createPrismaPostingStore(async () => db).read('missing')).resolves.toBeNull();
  });

  it('lists newest first with a cursor', async () => {
    const { f } = await setup();
    const page = await f.service.list(U, {});
    expect(page.items).toHaveLength(1);
    expect(page.cursor).toBeNull();
    expect(page.aiAvailable).toBe(true);
    expect(page.items[0]!.preview.startsWith('Dear Hiring Manager,')).toBe(true);
  });
});

describe('export', () => {
  it('PDF carries the AI label; attached export records the exact file; GoApply logs the label', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, market: 'cn', footerEnabled: true, now });
    const letter = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', locale: 'en', trackerEntryId: 'te_1' });
    expect(letter.pdfAvailable).toBe(true);
    f.labelLogs.length = 0;
    const file = await f.service.exportFile(U, letter.id, { format: 'pdf', trackerEntryId: 'te_1' });
    expect(file.contentType).toBe('application/pdf');
    expect(file.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = file.buffer.toString('latin1');
    expect(raw).toMatch(/AIContentID/);
    expect(raw).toMatch(/aigc:ContentID/);
    expect(file.fileName).toBe('Cover letter - Senior Backend Engineer · Stripe.pdf');
    expect(file.contentDisposition).toMatch(/filename\*=UTF-8''Cover%20letter/);
    expect(f.store.artifacts).toEqual([expect.objectContaining({ trackerEntryId: 'te_1', coverLetterId: letter.id, format: 'pdf', fileSha256: file.sha256, channel: 'download' })]);
    expect(f.labelLogs).toEqual([expect.objectContaining({ kind: 'cover_letter', artifactId: letter.id })]);
  });

  it('DOCX carries the label as custom properties; no artifact without an application', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, now });
    const letter = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1' });
    const file = await f.service.exportFile(U, letter.id, { format: 'docx' });
    expect(file.buffer.subarray(0, 2).toString()).toBe('PK');
    expect(f.store.artifacts).toHaveLength(0);
    expect(f.labelLogs).toHaveLength(0); // RoboApply writes no label row
  });

  it('Chinese PDF without bundled CJK fonts: refused before any row is written; Word still works', async () => {
    const kit = createCreditTestKit({ now: NOW });
    const f = createFixture({ credits: kit.credits, market: 'cn', footerEnabled: true, now });
    const letter = await f.service.create(U, { jobId: 'job_1', resumeVariantId: 'rv_1', locale: 'zh', trackerEntryId: 'te_1' });
    const zh = await f.service.patch(U, letter.id, { bodyMarkdown: '尊敬的招聘经理：\n\n我在 Acme Pay 负责把 7 个 Postgres 集群迁移到 AWS Aurora。\n\n此致\n敬礼' });
    f.labelLogs.length = 0;
    if (cjkFontsFor('zh') === null) {
      expect(zh.pdfAvailable).toBe(false);
      await expectHttp(f.service.exportFile(U, letter.id, { format: 'pdf', trackerEntryId: 'te_1' }), 'conflict', 'pdf_font_unavailable');
      expect(f.store.artifacts).toHaveLength(0);
      expect(f.labelLogs).toHaveLength(0);
    } else {
      // Fonts bundled (WP-36b): the PDF prints.
      expect(zh.pdfAvailable).toBe(true);
      expect((await f.service.exportFile(U, letter.id, { format: 'pdf' })).buffer.subarray(0, 5).toString()).toBe('%PDF-');
    }
    const docx = await f.service.exportFile(U, letter.id, { format: 'docx', trackerEntryId: 'te_1' });
    expect(docx.fileName).toBe('求职信 - Senior Backend Engineer · Stripe.docx');
    expect(f.store.artifacts.at(-1)).toMatchObject({ format: 'docx', coverLetterId: letter.id });
  });

  it('providerOf reads the vendor of a model id', () => {
    expect(providerOf('openrouter/openai/gpt-5')).toBe('openai');
    expect(providerOf('deepseek/deepseek-chat')).toBe('deepseek');
    expect(providerOf(null)).toBe('llm');
  });
});
