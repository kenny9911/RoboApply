// extension/test/helpers.ts — fixtures, a sample profile, and a fake API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtApi } from '../src/content/bridge';
import type { AutofillProfile } from '../src/shared/contract';
import type { ApiCall, ApiResult } from '../src/shared/messages';

export const FIXTURES = join(__dirname, 'fixtures');

/** Load a saved form into the jsdom document (scripts in fixtures are never run). */
export function loadFixture(ats: string, name: string): Document {
  const html = readFileSync(join(FIXTURES, ats, `${name}.html`), 'utf8');
  const inner = html.replace(/<!doctype[^>]*>/i, '').replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
  document.documentElement.innerHTML = inner;
  return document;
}

export function sampleProfile(overrides: Partial<AutofillProfile> = {}): AutofillProfile {
  return {
    profile: {
      firstName: 'Avery',
      lastName: 'Lin',
      contactEmail: 'avery@example.test',
      phoneE164: '+15125550100',
      city: 'Austin',
      region: 'Texas',
      country: 'US',
      postalCode: '78701',
      links: { linkedin: 'https://www.linkedin.com/in/avery-example' },
    },
    education: [{ school: 'Example State University', degree: 'BS', major: 'Computer Science' }],
    experience: [{ company: 'Prior Corp', title: 'Software Engineer', current: true }],
    links: { linkedin: 'https://www.linkedin.com/in/avery-example', github: 'https://github.com/avery-example', portfolio: 'https://avery.example.test' },
    workAuth: [{ country: 'US', authorized: true, sponsorship: 'no' }],
    answers: [],
    sensitive: null,
    ...overrides,
  };
}

type Handler = (call: ApiCall) => ApiResult<unknown> | Promise<ApiResult<unknown>>;

export interface FakeApi {
  api: ExtApi;
  calls: ApiCall[];
  ops(): string[];
}

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

export function fail(code: string, status = 400, details?: unknown): ApiResult<never> {
  return { ok: false, code, status, details };
}

/** Default answers for every op; override per test. */
export function fakeApi(overrides: Partial<Record<ApiCall['op'], Handler>> = {}, profile: AutofillProfile = sampleProfile()): FakeApi {
  const calls: ApiCall[] = [];
  const defaults: Record<ApiCall['op'], Handler> = {
    me: () => ok({ user: { id: 'u1', email: 'avery@example.test', firstName: 'Avery' }, brand: { id: 'roboapply', name: 'RoboApply' }, entitlements: null, flags: { aiAnswers: true }, profileCompleteness: 80 }),
    autofillProfile: () => ok(profile),
    pageJob: () => ok({ jobId: 'job_1', fit: { score: 82, tier: 'great', kind: 'pre' } }),
    saveJob: () => ok({ trackerEntryId: 't1' }),
    createRun: () => ok({ runId: 'run_1' }),
    patchRun: () => ok(null),
    answer: () => ok({ answer: 'I like small teams that ship often.', source: 'ai', saveable: true }),
    resumeForJob: () => ok({ variantId: 'v1', isTailored: true, fileName: 'Avery_Lin_Resume.pdf', downloadUrl: 'http://localhost:3611/api/v1/roboapply/ext/files/signed-token-abcdefgh' }),
    fetchFile: () => ok({ base64: btoa('%PDF-1.4 test'), contentType: 'application/pdf', fileName: null }),
    siteRequest: () => ok(null),
  };
  const api = (async (call: ApiCall) => {
    calls.push(call);
    const h = overrides[call.op] ?? defaults[call.op];
    return h(call);
  }) as ExtApi;
  return { api, calls, ops: () => calls.map((c) => c.op) };
}

export function field<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}
