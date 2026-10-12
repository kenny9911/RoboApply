// @vitest-environment node
//
// POST /:id/keyword-report { tailorSessionId }: the keyword check of a tailor
// session's own posting. A session made from a pasted posting keeps the text
// on the session, so the result view names the session and the server reads
// the posting (QA: a pasted post had no keyword step and no keyword grid).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { fakeAuth, startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import { createResumeSuiteRouter } from './routes.js';
import type { KeywordReportResponse, TailorSessionView } from './contract.js';
import { ResumeCheckService } from './ResumeCheckService.js';
import { createMemoryResumeCheckStore, memoryVariant } from './memoryStore.js';
import { TailorService } from './tailor/TailorService.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant } from './tailor/memoryStore.js';

const BASE_PATH = '/api/v1/roboapply/v2/resumes';
const USER = 'u_kw';
const OTHER = 'u_other';
const RESUME = '# Maya\n*maya@example.test*\n## Experience\n- Built weekly sales reports in SQL and Python.\n## Skills\nSQL · Python\n';
const JD = { title: 'Analytics Engineer', company: 'Cedar Ridge', text: 'We model data in Snowflake with dbt and build Looker dashboards. SQL and Python daily.' };

type Env<T> = { success: boolean; data: T; code?: string };
let h: RouteHarness;
const tailorStore = createMemoryTailorStore();
const checkStore = createMemoryResumeCheckStore();
const kit = createCreditTestKit();
const tailor = new TailorService({
  store: tailorStore,
  credits: kit.credits,
  aiAvailable: async () => true,
  market: () => 'intl',
  tailor: async () => ({ tailoredResumeMarkdown: '## Experience\n- Built weekly sales reports in SQL and Python.\n## Skills\nSQL · Python\n', changeSummary: '', citationsByLine: {}, citationGuardPassed: true, citationGuardViolations: [] }),
  profileContext: async () => null,
  score: async () => null,
  markChecklist: async () => undefined,
  logAiLabel: async () => undefined,
  assertPhoneBound: async () => undefined,
});
const check = new ResumeCheckService({
  store: checkStore,
  credits: kit.credits,
  aiAvailable: async () => true,
  profile: () => 'intl',
  market: () => 'intl',
  runAiPass: vi.fn(),
  rewrite: vi.fn(),
  logAiLabel: async () => undefined,
  // As in defaultResumeCheckDeps(): terms in the posting's own casing.
  keywordCasing: 'posting',
});

beforeAll(async () => {
  tailorStore.variants.set('rv_1', memoryTailorVariant(USER, 'rv_1', RESUME));
  tailorStore.jobs.set('job_1', memoryTailorJob('job_1', { title: 'Data Analyst', descriptionPlain: 'Dashboards in Tableau and SQL.', skills: ['tableau', 'sql'] }));
  checkStore.variants.set('rv_1', memoryVariant(USER, 'rv_1', RESUME));
  checkStore.jobs.set('job_1', { id: 'job_1', title: 'Data Analyst', descriptionPlain: 'Dashboards in Tableau and SQL.', qualifications: null, responsibilities: null, minYears: null, educationLevel: null, skills: ['tableau', 'sql'] });
  const auth = { seekerAuth: [fakeAuth((req) => ({ id: String(req.headers['x-test-user'] ?? USER) }))] };
  h = await startRouteHarness({ mounts: [[BASE_PATH, createResumeSuiteRouter(auth, { tailor, service: check, phoneGate: (_req, _res, next) => next() })]] });
});
afterAll(async () => {
  await h.close();
});

describe('keyword report for a tailor session', () => {
  it('a pasted-posting session: the report is built from the posting kept on the session', async () => {
    const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, {
      body: { baseVariantId: 'rv_1', jd: JD, mode: 'guided', sections: ['skills'], keywords: [] },
    });
    expect(created.status).toBe(200);
    const sessionId = created.body.data.id;
    expect(created.body.data.jobId).toBeNull();

    const res = await h.request<Env<KeywordReportResponse>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { body: { tailorSessionId: sessionId } });
    expect(res.status).toBe(200);
    expect(res.body.data.keywordSource).toBe('posting');
    expect(res.body.data.skillGaps).toEqual(['dbt', 'Snowflake', 'Looker']);
    expect(res.body.data.hardSkills.matched).toEqual(['Python', 'SQL']);

    // Same answer as posting the text itself.
    const direct = await h.request<Env<KeywordReportResponse>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { body: { jd: JD } });
    expect(direct.body.data.skillGaps).toEqual(res.body.data.skillGaps);

    // Another user cannot read the posting through the session id.
    const other = await h.request<Env<unknown>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { headers: { 'x-test-user': OTHER }, body: { tailorSessionId: sessionId } });
    expect(other.status).toBe(404);
  });

  it('a job session resolves to its job', async () => {
    const created = await h.request<Env<TailorSessionView>>('POST', `${BASE_PATH}/tailor-sessions`, {
      body: { baseVariantId: 'rv_1', jobId: 'job_1', mode: 'guided', sections: ['skills'], keywords: [] },
    });
    const res = await h.request<Env<KeywordReportResponse>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { body: { tailorSessionId: created.body.data.id } });
    expect(res.status).toBe(200);
    expect(res.body.data.skillGaps).toEqual(['Tableau']);
  });

  it('422 for a body that names two targets, 404 for an unknown session', async () => {
    const both = await h.request<Env<unknown>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { body: { tailorSessionId: 'ts_x', jobId: 'job_1' } });
    expect(both.status).toBe(422);
    const missing = await h.request<Env<unknown>>('POST', `${BASE_PATH}/rv_1/keyword-report`, { body: { tailorSessionId: 'nope' } });
    expect(missing.status).toBe(404);
  });
});
