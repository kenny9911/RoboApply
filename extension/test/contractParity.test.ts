// The extension mirrors the /ext contract (server/src/features/extension/contract.ts, WP-55a).

import { describe, expect, it } from 'vitest';

import * as server from '../../server/src/features/extension/contract';
import { FREE_TEXT_NOT_GRADES, PROTECTED_SAMPLES } from '../../server/src/features/extension/questionSamples';
import * as serverQuestions from '../../server/src/features/extension/questionTypes';
import { CN_PORTAL_ADAPTERS } from '../src/adapters/cn/index';
import { INTL_ADAPTERS, MULTI_PAGE_STEP, ONE_RUN_MULTI_PAGE } from '../src/adapters/intl/index';
import { GRADES_RE, protectedQuestionType } from '../src/mapping/questions';
import * as ext from '../src/shared/contract';

describe('contract mirror', () => {
  it('matches the server constants', () => {
    expect([...ext.PROTECTED_QUESTION_TYPES]).toEqual([...server.PROTECTED_QUESTION_TYPES]);
    expect([...ext.AUTOFILL_OUTCOMES]).toEqual([...server.AUTOFILL_OUTCOMES]);
    expect(ext.EXT_TOKEN_PREFIX).toBe(server.EXT_TOKEN_PREFIX);
    expect(ext.EXT_TOKEN_RE.source).toBe(server.EXT_TOKEN_RE.source);
    expect(ext.PAIR_CODE_RE.source).toBe(server.PAIR_CODE_RE.source);
    expect([...ext.EXT_BROWSER_NAMES]).toEqual([...server.EXT_BROWSER_NAMES]);
    expect(ext.EXTENSION_ERROR_CODES).toEqual(server.EXTENSION_ERROR_CODES);
  });

  it('grades and test scores: the same pattern as the server, and the same verdicts on its samples', () => {
    expect(GRADES_RE.source).toBe(serverQuestions.GRADES_RE.source);
    expect(GRADES_RE.flags).toBe(serverQuestions.GRADES_RE.flags);
    for (const q of PROTECTED_SAMPLES.grades) expect(protectedQuestionType(q), q).toBe('grades');
    // Work achievements and open questions are not grades on either side.
    for (const q of FREE_TEXT_NOT_GRADES) {
      expect(serverQuestions.classifyQuestion(q), q).toBe('free_text');
      expect(protectedQuestionType(q), q).toBeNull();
    }
  });

  it('request bodies the extension sends pass the server schemas', () => {
    expect(server.RedeemPairCodeBodySchema.safeParse({ code: 'AB23CD45', name: 'Chrome', browser: 'Chrome', extVersion: '0.1.0' }).success).toBe(true);
    expect(server.PageJobBodySchema.safeParse({ url: 'https://boards.greenhouse.io/x/jobs/1', title: 'T', company: 'C', location: 'L', descriptionText: '' }).success).toBe(true);
    expect(server.CreateAutofillRunBodySchema.safeParse({ host: 'boards.greenhouse.io', atsType: 'greenhouse', url: 'https://boards.greenhouse.io/x/jobs/1', jobId: 'job_1', fieldsTotal: 13 }).success).toBe(true);
    expect(server.PatchAutofillRunBodySchema.safeParse({ fieldsFilled: 8, outcome: 'partial', userMarkedSubmitted: true }).success).toBe(true);
    // Page-by-page forms report running totals (R4).
    expect(server.PatchAutofillRunBodySchema.safeParse({ fieldsFilled: 16, fieldsTotal: 26, outcome: 'partial' } satisfies ext.PatchAutofillRunBody).success).toBe(true);
    expect(server.AnswerQuestionBodySchema.safeParse({ runId: 'run_1', question: 'Why?', fieldType: 'textarea', maxLength: 1000 }).success).toBe(true);
    expect(server.ResumeForJobBodySchema.safeParse({ jobId: 'job_1', runId: 'run_1' } satisfies ext.ResumeForJobBody).success).toBe(true);
    // No matched job: the run only (the server answers with the main resume).
    expect(server.ResumeForJobBodySchema.safeParse({ runId: 'run_1' } satisfies ext.ResumeForJobBody).success).toBe(true);
    expect(server.SaveAnswerBodySchema.safeParse({ runId: 'run_1', question: 'Why us?', answer: 'The mission.' } satisfies ext.SaveAnswerBody).success).toBe(true);
    for (const browser of ext.EXT_BROWSER_NAMES) {
      expect(server.RedeemPairCodeBodySchema.safeParse({ code: 'AB23CD45', name: browser, browser, extVersion: '0.1.0' } satisfies ext.RedeemPairCodeBody).success).toBe(true);
    }
    expect(server.SiteRequestBodySchema.safeParse({ host: 'acme.wd5.myworkdayjobs.com', url: 'https://acme.wd5.myworkdayjobs.com/x' }).success).toBe(true);
  });

  // Wave 5 gate: job pages offer the extension only on the hosts an adapter
  // has a permission for (server `EXTENSION_ATS_HOST_PATTERNS`).
  it("the server's host patterns are the adapters' hostPatterns", () => {
    const fromAdapters: Record<string, string[]> = {};
    for (const a of [...INTL_ADAPTERS, ...CN_PORTAL_ADAPTERS]) {
      if (a.id === 'generic') continue;
      fromAdapters[a.id] = [...new Set([...(fromAdapters[a.id] ?? []), ...a.hostPatterns])];
    }
    const serverPatterns = Object.fromEntries(Object.entries(server.EXTENSION_ATS_HOST_PATTERNS).map(([k, v]) => [k, [...v]]));
    expect(serverPatterns).toEqual(fromAdapters);
  });

  // R4: a page-by-page form is offered on job pages only once one run covers
  // the whole application (ONE_RUN_MULTI_PAGE); every other one stays listed.
  it('every page-by-page form the extension knows is either covered by one run or held back from job pages', () => {
    const held = server.EXTENSION_PER_PAGE_ATS_TYPES as readonly string[];
    for (const id of Object.keys(MULTI_PAGE_STEP)) {
      if ((ONE_RUN_MULTI_PAGE as readonly string[]).includes(id)) expect(held, id).not.toContain(id);
      else expect(held, id).toContain(id);
    }
    expect([...ONE_RUN_MULTI_PAGE]).toEqual(['workday']);
    for (const id of ONE_RUN_MULTI_PAGE) expect(Object.keys(MULTI_PAGE_STEP)).toContain(id);
  });

  it('the envelope keeps area reasons in details.reason (errorReason reads both)', () => {
    expect(ext.errorReason({ code: 'invalid_request', details: { reason: server.EXTENSION_ERROR_CODES.protectedQuestion, type: 'grades' } })).toBe('protected_question');
    expect(ext.errorReason({ code: 'protected_question' })).toBe('protected_question');
    expect(ext.errorReason({ code: 'credits_exhausted', details: { bucket: 'autofill' } })).toBe('credits_exhausted');
  });
});
