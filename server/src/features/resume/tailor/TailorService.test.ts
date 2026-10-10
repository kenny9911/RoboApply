// @vitest-environment node
//
// WP-36a acceptance (TailorService): with aiAvailable=false zero tailor/LLM
// calls and no credit; one `tailor` credit per session, committed on success,
// released on failure; a replayed Idempotency-Key returns the same session;
// the prompt never carries the contact header; claims are pending; finalize is
// blocked while any claim is pending (409 unverified_claims) and fires the
// checklist step once; scores are real AI fit scores or null; GoApply writes
// the AI-content label log; content_blocked passes through.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { createCreditTestKit, type CreditTestKit } from '../../../platform/credits/testkit.js';
import { HttpError } from '../../../platform/http.js';
import type { RAResumeTailorInput, RAResumeTailorOutput } from '../../../roboapply/v2/agents/RAResumeTailorAgent.js';
import { TailorService, UnverifiedClaimsError, GENERATING_STALE_MS, type FitScoreResult, type TailorServiceDeps } from './TailorService.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant, type MemoryTailorStore } from './memoryStore.js';
import type { CreateTailorBody } from './TailorService.js';

const USER = 'u_tailor';
const BASE = [
  '# Sam Lee',
  '*sam@example.test · +1 415 555 0100*',
  '## Summary',
  'Data analyst with SQL and Excel experience.',
  '## Experience',
  '### Bright Retail · Data Analyst · 2021 – present',
  '- Built weekly sales reports in SQL for 12 stores.',
  '## Skills',
  'SQL, Excel',
  '',
].join('\n');
const TAILORED = [
  '## Summary',
  'Data analyst with SQL and Excel experience.',
  '## Experience',
  '### Bright Retail · Data Analyst · 2021 – present',
  '- Built weekly sales reports in SQL for 12 stores.',
  '- Cut report time by 40% with automated dashboards.',
  '## Skills',
  'SQL, Excel, Tableau',
  '',
].join('\n');
const BODY: CreateTailorBody = { baseVariantId: 'rv_base', jobId: 'job_1', mode: 'guided', sections: ['experience', 'skills'], keywords: ['Tableau'], experienceDepth: 'full' };

let store: MemoryTailorStore;
let kit: CreditTestKit;
let ai: boolean;
let market: 'intl' | 'cn';
let tailor: ReturnType<typeof vi.fn<(input: RAResumeTailorInput, options: { locale?: string; signal?: AbortSignal }) => Promise<RAResumeTailorOutput>>>;
let score: ReturnType<typeof vi.fn<(userId: string, jobId: string, variantId: string) => Promise<FitScoreResult | null>>>;
let markChecklist: ReturnType<typeof vi.fn<(userId: string) => Promise<void>>>;
let logAiLabel: ReturnType<typeof vi.fn<TailorServiceDeps['logAiLabel']>>;
let profileContext: ReturnType<typeof vi.fn<(userId: string) => Promise<string | null>>>;
let assertPhoneBound: ReturnType<typeof vi.fn<(userId: string) => Promise<void>>>;
let now: Date;

const ok = (md = TAILORED): RAResumeTailorOutput => ({ tailoredResumeMarkdown: md, changeSummary: '', citationsByLine: {}, citationGuardPassed: true, citationGuardViolations: [] });

function service(over: Partial<TailorServiceDeps> = {}) {
  return new TailorService({
    store,
    credits: kit.credits,
    aiAvailable: async () => ai,
    assertPhoneBound,
    market: () => market,
    tailor,
    profileContext,
    score,
    markChecklist,
    logAiLabel,
    now: () => now,
    ...over,
  });
}

beforeEach(() => {
  store = createMemoryTailorStore({ now: () => now });
  now = new Date('2026-10-10T12:00:00Z');
  kit = createCreditTestKit({ now });
  ai = true;
  market = 'intl';
  store.variants.set('rv_base', memoryTailorVariant(USER, 'rv_base', BASE, 'Analyst resume'));
  store.jobs.set('job_1', memoryTailorJob('job_1', { title: 'Data Analyst', companyName: 'Acme Analytics', descriptionPlain: 'Build dashboards in Tableau.', skills: ['tableau'] }));
  tailor = vi.fn(async () => ok());
  score = vi.fn(async (_u, _j, variantId) => ({ score: variantId === 'rv_base' ? 61 : 74, kind: 'ai' as const, scoredAt: now.toISOString() }));
  markChecklist = vi.fn(async () => undefined);
  logAiLabel = vi.fn(async () => undefined);
  profileContext = vi.fn(async () => 'Target: data analyst roles.');
  assertPhoneBound = vi.fn(async () => undefined);
});

const used = () => kit.store.ledger.filter((r) => r.bucket === 'tailor' && r.status === 'committed').length;
const released = () => kit.store.ledger.filter((r) => r.bucket === 'tailor' && r.status === 'released').length;

describe('TailorService.create', () => {
  it('AI not allowed → 503 ai_unavailable, zero tailor calls, no credit reserved', async () => {
    ai = false;
    await expect(service().create(USER, BODY, { idempotencyKey: 'k0' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(tailor).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
    expect(profileContext).not.toHaveBeenCalled();
    expect(kit.store.ledger).toHaveLength(0);
  });

  it('GoApply WeChat account without a phone → 403 phone_binding_required, no credit, no model call', async () => {
    assertPhoneBound.mockRejectedValueOnce(Object.assign(new Error('Bind a phone number to use this feature.'), { code: 'phone_binding_required', status: 403 }));
    await expect(service().create(USER, BODY, { idempotencyKey: 'kp' })).rejects.toMatchObject({ code: 'phone_binding_required', status: 403 });
    expect(assertPhoneBound).toHaveBeenCalledWith(USER);
    expect(tailor).not.toHaveBeenCalled();
    expect(kit.store.ledger).toHaveLength(0);
  });

  it('the seam resumeSuiteService path is gated too: create() itself checks the phone', async () => {
    await service().create(USER, { ...BODY, mode: 'fast' }, { idempotencyKey: 'kq' });
    expect(assertPhoneBound).toHaveBeenCalledTimes(1);
  });

  it('writes a tailored version in review with pending claims, spends one credit, scores only the base', async () => {
    const view = await service().create(USER, BODY, { idempotencyKey: 'k1', locale: 'en' });
    expect(view.status).toBe('review');
    expect(view.resultVariantId).toBeTruthy();
    expect(view.pendingClaims).toBeGreaterThan(0);
    expect(view.claims.every((c) => c.status === 'pending')).toBe(true);
    expect(view.claims.map((c) => c.text)).toEqual(expect.arrayContaining(['Cut report time by 40% with automated dashboards.', 'SQL, Excel, Tableau']));
    expect(view.changes.length).toBeGreaterThan(0);
    expect(view.target).toEqual({ title: 'Data Analyst', company: 'Acme Analytics' });
    // The tailored text still holds unchecked claims: no "after" score yet (it is computed at finalize).
    expect(view).toMatchObject({ scoreBefore: 61, scoreAfter: null, aiWritten: true, mode: 'guided', sections: ['experience', 'skills'], experienceDepth: 'full' });
    expect(store.sessions.get(view.id)!.sections).toEqual(['experience', 'skills', 'work_full']);
    expect(view.fit.before).toMatchObject({ value: 61, source: 'ai', method: 'fit_score' });
    expect(view.fit.after).toBeNull();
    expect(score).toHaveBeenCalledTimes(1);
    expect(score).toHaveBeenCalledWith(USER, 'job_1', 'rv_base', 'en');
    expect(used()).toBe(1);

    const result = store.variants.get(view.resultVariantId!)!;
    expect(result).toMatchObject({ kind: 'tailored_for_jd', sourceKind: 'tailored', targetJobId: 'job_1', basedOnVariantId: 'rv_base', unverifiedClaims: view.pendingClaims });
    expect(result.resumeMarkdown.startsWith('# Sam Lee\n*sam@example.test')).toBe(true);
    expect(result.name).toBe('Analyst resume · Acme Analytics · Data Analyst');
    expect(await service().unverifiedClaimsCount(view.resultVariantId!)).toBe(view.pendingClaims);
  });

  it('the prompt carries no name or contact line, only confirmed keywords, the sections and the profile snapshot', async () => {
    await service().create(USER, { ...BODY, customPrompt: 'Lead with reporting.' }, { idempotencyKey: 'k2' });
    const input = tailor.mock.calls[0]![0];
    expect(input.baseResumeMarkdown).not.toContain('Sam Lee');
    expect(input.baseResumeMarkdown).not.toContain('sam@example.test');
    expect(input.baseResumeMarkdown).not.toContain('415');
    expect(input).toMatchObject({
      sections: ['experience', 'skills'],
      experienceDepth: 'full',
      confirmedKeywords: ['Tableau'],
      instruction: 'Lead with reporting.',
      profileContext: 'Target: data analyst roles.',
    });
    expect(input.parsedJD?.keywords).toBeUndefined();
  });

  it('a replayed Idempotency-Key returns the same session and never charges twice', async () => {
    const svc = service();
    const a = await svc.create(USER, BODY, { idempotencyKey: 'same' });
    const b = await svc.create(USER, BODY, { idempotencyKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(tailor).toHaveBeenCalledTimes(1);
    expect(used()).toBe(1);
  });

  it('a failed model call releases the credit and marks the session failed', async () => {
    tailor.mockRejectedValueOnce(new Error('provider 500'));
    await expect(service().create(USER, BODY, { idempotencyKey: 'k3' })).rejects.toMatchObject({ code: 'ai_unavailable', details: { reason: 'ai_failed' } });
    expect(used()).toBe(0);
    expect(released()).toBe(1);
    expect([...store.sessions.values()][0]!.status).toBe('failed');
  });

  it('an empty model answer is a failure (no credit)', async () => {
    tailor.mockResolvedValueOnce(ok('  '));
    await expect(service().create(USER, BODY, { idempotencyKey: 'k4' })).rejects.toBeInstanceOf(HttpError);
    expect(used()).toBe(0);
  });

  it('content_blocked passes through unchanged (never retried on another model)', async () => {
    tailor.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'content_blocked', details: { stage: 'input' } }));
    await expect(service().create(USER, BODY, { idempotencyKey: 'k5' })).rejects.toMatchObject({ code: 'content_blocked' });
    expect(tailor).toHaveBeenCalledTimes(1);
    expect(released()).toBe(1);
  });

  it('no credit left → 402 before any model call', async () => {
    const svc = service();
    await svc.create(USER, BODY, { idempotencyKey: 'a' });
    await svc.create(USER, BODY, { idempotencyKey: 'b' });
    tailor.mockClear();
    await expect(svc.create(USER, BODY, { idempotencyKey: 'c' })).rejects.toMatchObject({ code: 'credits_exhausted' });
    expect(tailor).not.toHaveBeenCalled();
  });

  it('a quick estimate is never shown as a fit score', async () => {
    score.mockImplementation(async () => ({ score: 50, kind: 'pre' as const, scoredAt: now.toISOString() }));
    const view = await service().create(USER, BODY, { idempotencyKey: 'k6' });
    expect(view).toMatchObject({ scoreBefore: null, scoreAfter: null, fit: { before: null, after: null } });
  });

  it('a pasted posting tailors without a job (no score)', async () => {
    const view = await service().create(
      USER,
      { baseVariantId: 'rv_base', jd: { title: 'Analyst', company: 'Beta', text: 'We need SQL and Tableau dashboards for our retail team.' }, mode: 'fast', sections: ['skills'], keywords: [], experienceDepth: 'quick' },
      { idempotencyKey: 'k7' },
    );
    expect(view).toMatchObject({ jobId: null, target: { title: 'Analyst', company: 'Beta' }, scoreBefore: null, mode: 'fast', experienceDepth: null });
    expect(score).not.toHaveBeenCalled();
    expect(store.variants.get(view.resultVariantId!)!.targetJobId).toBeNull();
  });

  it('404 for another user resume or a job of the other market', async () => {
    store.variants.set('rv_other', memoryTailorVariant('someone', 'rv_other', BASE));
    await expect(service().create(USER, { ...BODY, baseVariantId: 'rv_other' })).rejects.toMatchObject({ code: 'not_found' });
    store.jobs.set('job_cn', memoryTailorJob('job_cn', { market: 'cn' }));
    await expect(service().create(USER, { ...BODY, jobId: 'job_cn' })).rejects.toMatchObject({ code: 'not_found' });
    expect(tailor).not.toHaveBeenCalled();
  });

  it('GoApply logs the AI-content label; RoboApply does not', async () => {
    await service().create(USER, BODY, { idempotencyKey: 'k8' });
    expect(logAiLabel).not.toHaveBeenCalled();
    market = 'cn';
    store.jobs.set('job_1', { ...store.jobs.get('job_1')!, market: 'cn' });
    const view = await service().create(USER, BODY, { idempotencyKey: 'k9' });
    expect(logAiLabel).toHaveBeenCalledWith({ userId: USER, contentId: `resume_tailor:${view.id}`, kind: 'resume_tailor' });
  });

  it('a request that died while generating shows as stopped', async () => {
    const s = await store.createSession({ userId: USER, baseVariantId: 'rv_base', jobId: null, jdSnapshot: null, mode: 'guided', sections: ['skills'], customPrompt: null, keywordsSelected: [], creditLedgerId: 'l1' });
    now = new Date(now.getTime() + GENERATING_STALE_MS + 1000);
    const view = await service().get(USER, s.id);
    expect(view).toMatchObject({ status: 'failed', failure: 'stopped' });
  });
});

describe('Verify details and finalize', () => {
  async function started() {
    const svc = service();
    const view = await svc.create(USER, BODY, { idempotencyKey: `k-${Math.random()}` });
    return { svc, view };
  }

  it('finalize is blocked while any claim is pending: 409 unverified_claims with the count', async () => {
    const { svc, view } = await started();
    const err = await svc.finalize(USER, view.id).catch((e) => e);
    expect(err).toBeInstanceOf(UnverifiedClaimsError);
    expect(err).toMatchObject({ status: 409, code: 'unverified_claims', details: { pending: view.pendingClaims } });
    expect(markChecklist).not.toHaveBeenCalled();
  });

  it('kept / removed / edited update the tailored version and its unverified count', async () => {
    const { svc, view } = await started();
    const numberClaim = view.claims.find((c) => c.text.startsWith('Cut report time'))!;
    const skillsClaim = view.claims.find((c) => c.text.includes('Tableau'))!;

    const afterEdit = await svc.updateClaim(USER, view.id, numberClaim.id, { status: 'edited', text: 'Automated two dashboards.' });
    expect(afterEdit.pendingClaims).toBe(view.pendingClaims - 1);
    const md = store.variants.get(view.resultVariantId!)!.resumeMarkdown;
    expect(md).toContain('- Automated two dashboards.');
    expect(md).not.toContain('40%');
    expect(store.variants.get(view.resultVariantId!)!.unverifiedClaims).toBe(afterEdit.pendingClaims);

    const afterRemove = await svc.updateClaim(USER, view.id, skillsClaim.id, { status: 'removed' });
    expect(store.variants.get(view.resultVariantId!)!.resumeMarkdown).toContain('SQL, Excel\n');
    for (const c of afterRemove.claims.filter((x) => x.status === 'pending')) await svc.updateClaim(USER, view.id, c.id, { status: 'kept' });

    const removedAgain = await svc.updateClaim(USER, view.id, skillsClaim.id, { status: 'kept' }).catch((e) => e);
    expect(removedAgain).toMatchObject({ code: 'conflict', details: { reason: 'tailor_claim_locked' } });
  });

  it('the after score stays hidden while claims are pending, even once some are decided', async () => {
    const { svc, view } = await started();
    const one = await svc.updateClaim(USER, view.id, view.claims[0]!.id, { status: 'kept' });
    expect(one.fit.after).toBeNull();
    expect(one.scoreAfter).toBeNull();
    expect(one.fit.before).toMatchObject({ value: 61 });
  });

  it('finalize after every claim is checked: status finalized, checklist step once, score of the final text', async () => {
    const { svc, view } = await started();
    for (const c of view.claims) await svc.updateClaim(USER, view.id, c.id, { status: 'kept' });
    score.mockClear();
    const done = await svc.finalize(USER, view.id);
    expect(done.status).toBe('finalized');
    expect(done.pendingClaims).toBe(0);
    expect(done).toMatchObject({ scoreBefore: 61, scoreAfter: 74 });
    expect(done.fit.after).toMatchObject({ value: 74, source: 'ai', method: 'fit_score' });
    expect(markChecklist).toHaveBeenCalledTimes(1);
    expect(markChecklist).toHaveBeenCalledWith(USER);
    expect(score).toHaveBeenCalledWith(USER, 'job_1', view.resultVariantId, undefined);
    expect(await svc.unverifiedClaimsCount(view.resultVariantId!)).toBe(0);

    const again = await svc.finalize(USER, view.id);
    expect(again.status).toBe('finalized');
    expect(markChecklist).toHaveBeenCalledTimes(1);
    await expect(svc.updateClaim(USER, view.id, view.claims[0]!.id, { status: 'kept' })).rejects.toMatchObject({ details: { reason: 'tailor_session_not_reviewable' } });
  });

  it('an after score that is not a real AI fit score shows "—" next to the real before score', async () => {
    const { svc, view } = await started();
    for (const c of view.claims) await svc.updateClaim(USER, view.id, c.id, { status: 'kept' });
    score.mockImplementation(async () => ({ score: 90, kind: 'pre' as const, scoredAt: now.toISOString() }));
    const done = await svc.finalize(USER, view.id);
    expect(done).toMatchObject({ scoreBefore: 61, scoreAfter: null, fit: { after: null } });
  });

  it('removing a line the AI wrote twice removes every copy', async () => {
    const twice = [
      '## Summary',
      'Data analyst with SQL and Excel experience.',
      '## Experience',
      '### Bright Retail · Data Analyst · 2021 – present',
      '- Built weekly sales reports in SQL for 12 stores.',
      '- Managed a team of 12 engineers.',
      '## Skills',
      'SQL, Excel',
      '- Managed a team of 12 engineers.',
      '',
    ].join('\n');
    tailor.mockResolvedValueOnce(ok(twice));
    const svc = service();
    const view = await svc.create(USER, BODY, { idempotencyKey: 'k-twice' });
    const dup = view.claims.filter((c) => c.text === 'Managed a team of 12 engineers.');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.copies).toHaveLength(2);
    const after = await svc.updateClaim(USER, view.id, dup[0]!.id, { status: 'removed' });
    expect(store.variants.get(view.resultVariantId!)!.resumeMarkdown).not.toContain('Managed a team of 12 engineers');
    expect(after.claims.find((c) => c.id === dup[0]!.id)!.status).toBe('removed');
  });

  it('a checklist failure never fails finalize', async () => {
    const { svc, view } = await started();
    for (const c of view.claims) await svc.updateClaim(USER, view.id, c.id, { status: 'kept' });
    markChecklist.mockRejectedValueOnce(new Error('growth down'));
    await expect(svc.finalize(USER, view.id)).resolves.toMatchObject({ status: 'finalized' });
  });

  it('another user cannot read or change a session', async () => {
    const { svc, view } = await started();
    await expect(svc.get('intruder', view.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.updateClaim('intruder', view.id, view.claims[0]!.id, { status: 'kept' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.finalize('intruder', view.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('unknown claim → 404', async () => {
    const { svc, view } = await started();
    await expect(svc.updateClaim(USER, view.id, 'nope', { status: 'kept' })).rejects.toMatchObject({ code: 'not_found', details: { reason: 'tailor_claim_not_found' } });
  });
});

describe('reviewSessionIds (the hub\'s "Verify details" links, INT-10)', () => {
  it('maps a tailored version to its session while it is in review, and drops it once finalized', async () => {
    const svc = service();
    const view = await svc.create(USER, BODY, { idempotencyKey: 'hub-1' });
    const variantId = view.resultVariantId!;
    expect(view.pendingClaims).toBeGreaterThan(0);
    await expect(svc.reviewSessionIds(USER, [variantId, 'rv_base', 'unknown'])).resolves.toEqual({ [variantId]: view.id });

    for (const c of view.claims) await svc.updateClaim(USER, view.id, c.id, { status: 'kept' });
    await svc.finalize(USER, view.id);
    await expect(svc.reviewSessionIds(USER, [variantId])).resolves.toEqual({});
  });

  it('is scoped to the user and asks nothing for an empty list', async () => {
    const svc = service();
    const view = await svc.create(USER, BODY, { idempotencyKey: 'hub-2' });
    await expect(svc.reviewSessionIds('intruder', [view.resultVariantId!])).resolves.toEqual({});
    const spy = vi.spyOn(store, 'findReviewSessions');
    await expect(svc.reviewSessionIds(USER, [])).resolves.toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('pasted posting (jd) sessions — the editor\'s target step (INT-10)', () => {
  it('tailors from { title, company, text } with no job: one credit, claims checked, target named from the posting', async () => {
    const svc = service();
    const jd = { title: 'Sales Analyst', company: 'Globex', text: 'We need an analyst who builds Tableau dashboards and SQL reports for the sales team every week.' };
    const view = await svc.create(USER, { baseVariantId: 'rv_base', jd, mode: 'guided', sections: ['experience', 'skills'], keywords: [], experienceDepth: 'quick' }, { idempotencyKey: 'jd-1' });
    expect(view.jobId).toBeNull();
    expect(view.target).toEqual({ title: 'Sales Analyst', company: 'Globex' });
    expect(view.status).toBe('review');
    expect(view.pendingClaims).toBeGreaterThan(0);
    expect(used()).toBe(1);
    // The model got the pasted text; no fit score is invented for a posting with no job record.
    expect(tailor.mock.calls[0]![0]).toMatchObject({ jobTitle: 'Sales Analyst', companyName: 'Globex' });
    expect(tailor.mock.calls[0]![0].jobDescription).toContain('Tableau dashboards');
    expect(score).not.toHaveBeenCalled();
    expect(view.fit).toEqual({ before: null, after: null });
    expect(store.variants.get(view.resultVariantId!)!.unverifiedClaims).toBe(view.pendingClaims);
  });
});
