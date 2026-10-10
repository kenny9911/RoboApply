// The extension mirrors the /ext contract (server/src/features/extension/contract.ts, WP-55a).

import { describe, expect, it } from 'vitest';

import * as server from '../../server/src/features/extension/contract';
import { CN_PORTAL_ADAPTERS } from '../src/adapters/cn/index';
import { INTL_ADAPTERS, MULTI_PAGE_STEP } from '../src/adapters/intl/index';
import * as ext from '../src/shared/contract';

describe('contract mirror', () => {
  it('matches the server constants', () => {
    expect([...ext.PROTECTED_QUESTION_TYPES]).toEqual([...server.PROTECTED_QUESTION_TYPES]);
    expect([...ext.AUTOFILL_OUTCOMES]).toEqual([...server.AUTOFILL_OUTCOMES]);
    expect(ext.EXT_TOKEN_PREFIX).toBe(server.EXT_TOKEN_PREFIX);
    expect(ext.EXT_TOKEN_RE.source).toBe(server.EXT_TOKEN_RE.source);
    expect(ext.EXTENSION_ERROR_CODES).toEqual(server.EXTENSION_ERROR_CODES);
  });

  it('request bodies the extension sends pass the server schemas', () => {
    expect(server.RedeemPairCodeBodySchema.safeParse({ code: 'AB23CD45', name: 'Chrome', browser: 'Chrome', extVersion: '0.1.0' }).success).toBe(true);
    expect(server.PageJobBodySchema.safeParse({ url: 'https://boards.greenhouse.io/x/jobs/1', title: 'T', company: 'C', location: 'L', descriptionText: '' }).success).toBe(true);
    expect(server.CreateAutofillRunBodySchema.safeParse({ host: 'boards.greenhouse.io', atsType: 'greenhouse', url: 'https://boards.greenhouse.io/x/jobs/1', jobId: 'job_1', fieldsTotal: 13 }).success).toBe(true);
    expect(server.PatchAutofillRunBodySchema.safeParse({ fieldsFilled: 8, outcome: 'partial', userMarkedSubmitted: true }).success).toBe(true);
    expect(server.AnswerQuestionBodySchema.safeParse({ runId: 'run_1', question: 'Why?', fieldType: 'textarea', maxLength: 1000 }).success).toBe(true);
    expect(server.ResumeForJobBodySchema.safeParse({ jobId: 'job_1', runId: 'run_1' }).success).toBe(true);
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

  it('every page-by-page form the extension knows is held back from job pages until R4', () => {
    for (const id of Object.keys(MULTI_PAGE_STEP)) expect(server.EXTENSION_PER_PAGE_ATS_TYPES as readonly string[]).toContain(id);
  });
});
