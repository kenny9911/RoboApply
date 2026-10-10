// @vitest-environment node
//
// WP-22 acceptance (service level): AI consent off → zero LLM calls and no
// credit; the AI pass is metered (commit on success, release on failure or
// cancel); CitationGuard blocks invented numbers in fixes; GoApply grades with
// the cn profile and logs AI labels; the onboarding grant is idempotent.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
// A real LLM call would go through LLMService: make any such call fail loudly.
vi.mock('../../services/llm/LLMService.js', () => {
  const chat = vi.fn(() => {
    throw new Error('LLMService must not be called in this test');
  });
  return { llmService: { chat }, LLMService: class {} };
});

import { createCreditTestKit, type CreditTestKit } from '../../platform/credits/testkit.js';
import { HttpError } from '../../platform/http.js';
import { ResumeCheckService, actionFor, type ResumeCheckDeps } from './ResumeCheckService.js';
import { rulesCountFor } from './check/taxonomy.js';
import { createMemoryResumeCheckStore, memoryVariant, type MemoryResumeCheckStore } from './memoryStore.js';
import { GOOD_INTL } from './check/fixtures.js';
import type { AiPassOutput } from './check/aiPass.js';

const USER = 'user_1';
const NOW = new Date('2026-10-10T12:00:00Z');

const WEAK = [
  '# Sam Doe',
  '*sam@example.test · +1 415 555 0100*',
  '## Summary',
  'I am a hard-working person who likes to recieve feedback.',
  '## Experience',
  '### Shop · Assistant · 2022 – 2024',
  '- Responsible for opening the store every morning.',
  '- Helped with inventory.',
  '- Worked on displays.',
  '## Education',
  '### BA History · Some College · 2018 – 2022',
  '## Skills',
  'Excel · Customer service · Cash handling · Scheduling · Inventory',
].join('\n');

interface Harness {
  store: MemoryResumeCheckStore;
  kit: CreditTestKit;
  deps: ResumeCheckDeps;
  service: ResumeCheckService;
  runAiPass: ReturnType<typeof vi.fn>;
  rewrite: ReturnType<typeof vi.fn>;
  logAiLabel: ReturnType<typeof vi.fn>;
  setAi(v: boolean): void;
}

function setup(options: { market?: 'intl' | 'cn'; ai?: boolean; aiOutput?: AiPassOutput | Error } = {}): Harness {
  const store = createMemoryResumeCheckStore({ now: () => NOW });
  store.variants.set('rv_1', memoryVariant(USER, 'rv_1', WEAK));
  store.variants.set('rv_good', memoryVariant(USER, 'rv_good', GOOD_INTL));
  const kit = createCreditTestKit({ now: NOW });
  let ai = options.ai ?? true;
  const runAiPass = vi.fn(async () => {
    const out = options.aiOutput ?? { spelling: [{ word: 'recieve', suggestion: 'receive' }], summaryVague: false };
    if (out instanceof Error) throw out;
    return out;
  });
  const rewrite = vi.fn(async () => ({ rewrite: 'Opened the store every morning and ran the till.' }));
  const logAiLabel = vi.fn(async () => undefined);
  const market = options.market ?? 'intl';
  const deps: ResumeCheckDeps = {
    store,
    credits: kit.credits,
    aiAvailable: async () => ai,
    profile: () => market,
    market: () => market,
    runAiPass,
    rewrite,
    logAiLabel,
    // As in defaultResumeCheckDeps(): these are stored resumes.
    hasTemplate: () => true,
    now: () => NOW,
    timeoutMs: 1000,
  };
  return { store, kit, deps, service: new ResumeCheckService(deps), runAiPass, rewrite, logAiLabel, setAi: (v) => (ai = v) };
}

async function bucket(kit: CreditTestKit, name: string) {
  const usage = await kit.credits.usage(USER);
  return usage.find((u) => u.bucket === name)!;
}

describe('grade', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('runs rules + the AI pass, stores the report and spends one resume_check credit', async () => {
    const res = await h.service.grade(USER, 'rv_1', { idempotencyKey: 'k1' });
    expect(res.grade!.status).toBe('done');
    expect(res.grade!.method).toBe('rules_ai');
    expect(res.grade!.aiSkipped).toBeNull();
    expect(res.grade!.issues.map((i) => i.type)).toEqual(expect.arrayContaining(['weak_verb', 'buzzwords', 'spelling']));
    expect(res.grade!.label).toBe('fair'); // spelling is "Fix first" → capped at Fair
    expect(res.grade!.counts!.urgent).toBe(1);
    expect(h.store.grades[0]!.grade).toBe('C');
    expect(h.runAiPass).toHaveBeenCalledTimes(1);
    expect(h.runAiPass.mock.calls[0]![0].resumeText).not.toMatch(/Sam Doe|sam@example/);
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([1, 0]);
  });

  it('with AI consent off: rules only, zero LLM calls, no credit spent', async () => {
    h.setAi(false);
    const res = await h.service.grade(USER, 'rv_1');
    expect(res.grade!.method).toBe('rules');
    expect(res.grade!.aiSkipped).toBe('ai_unavailable');
    expect(res.grade!.issues.some((i) => i.source === 'ai')).toBe(false);
    expect(h.runAiPass).not.toHaveBeenCalled();
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([0, 0]);
  });

  it('releases the credit when the AI pass fails and keeps the rules report', async () => {
    h = setup({ aiOutput: new Error('provider down') });
    const res = await h.service.grade(USER, 'rv_1');
    expect(res.grade!.status).toBe('done');
    expect(res.grade!.method).toBe('rules');
    expect(res.grade!.aiSkipped).toBe('ai_failed');
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([0, 0]);
  });

  it('with no resume_check credit left: the free checklist still runs, the AI pass is skipped', async () => {
    await h.service.grade(USER, 'rv_1');
    h.runAiPass.mockClear();
    const res = await h.service.grade(USER, 'rv_1');
    expect(res.grade!.status).toBe('done');
    expect(res.grade!.method).toBe('rules');
    expect(res.grade!.aiSkipped).toBe('credits_exhausted');
    expect(res.grade!.issues.some((i) => i.source === 'ai')).toBe(false);
    expect(res.grade!.issues.length).toBeGreaterThan(0);
    expect(h.runAiPass).not.toHaveBeenCalled();
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([1, 0]);
    // The reason survives a reload.
    expect((await h.service.latest(USER, 'rv_1')).grade!.aiSkipped).toBe('credits_exhausted');
  });

  it('other credit errors still fail the check', async () => {
    vi.spyOn(h.kit.credits, 'reserve').mockRejectedValueOnce(new Error('ledger down'));
    await expect(h.service.grade(USER, 'rv_1')).rejects.toThrow('ledger down');
    expect(h.store.grades).toHaveLength(0);
  });

  it('maps a replayed idempotency key to 409', async () => {
    await h.service.grade(USER, 'rv_1', { idempotencyKey: 'same' });
    await expect(h.service.grade(USER, 'rv_1', { idempotencyKey: 'same' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('404s for a resume of another user', async () => {
    h.store.variants.set('rv_x', memoryVariant('someone_else', 'rv_x', WEAK));
    await expect(h.service.grade(USER, 'rv_x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('grades GoApply resumes with the cn profile', async () => {
    h = setup({ market: 'cn', ai: false });
    h.store.variants.set('rv_cn', memoryVariant(USER, 'rv_cn', '# 张三\n电话：13800138000 邮箱：z@example.test\n## 教育背景\n### 某大学 · 本科在读 · 2024 – 2028\n## 专业技能\nJava、Python'));
    const res = await h.service.grade(USER, 'rv_cn');
    expect(res.grade!.profile).toBe('cn');
    expect(res.grade!.issues.map((i) => i.type)).toEqual(expect.arrayContaining(['cn_internship_missing', 'cn_english_cert_missing', 'cn_self_evaluation_missing']));
  });
});

describe('cancel', () => {
  it('a cancelled grade releases its credit and never commits', async () => {
    let release!: () => void;
    const h = setup();
    h.runAiPass.mockImplementationOnce(
      () =>
        new Promise<AiPassOutput>((resolve) => {
          release = () => resolve({ spelling: [], summaryVague: false });
        }),
    );
    const pending = h.service.grade(USER, 'rv_1');
    await vi.waitFor(() => expect(h.store.grades).toHaveLength(1));
    await vi.waitFor(async () => expect((await bucket(h.kit, 'resume_check')).reserved).toBe(1));
    const gradeId = h.store.grades[0]!.id;
    const cancelled = await h.service.cancel(USER, gradeId);
    expect(cancelled).toEqual({ gradeId, status: 'cancelled', released: true });
    release();
    const res = await pending;
    expect(res.grade!.status).toBe('cancelled');
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([0, 0]);
    // the latest view skips the cancelled row
    expect((await h.service.latest(USER, 'rv_1')).grade).toBeNull();
  });

  it('a cancel that lands just before the completion write wins (no done, no commit)', async () => {
    const h = setup();
    const complete = h.store.completeRunningGrade.bind(h.store);
    let cancelResult: unknown = null;
    vi.spyOn(h.store, 'completeRunningGrade').mockImplementationOnce(async (gradeId, data) => {
      cancelResult = await h.service.cancel(USER, gradeId);
      return complete(gradeId, data);
    });
    const res = await h.service.grade(USER, 'rv_1');
    expect(cancelResult).toMatchObject({ status: 'cancelled', released: true });
    expect(res.grade!.status).toBe('cancelled');
    expect(h.store.grades[0]!.status).toBe('cancelled');
    const b = await bucket(h.kit, 'resume_check');
    expect([b.used, b.reserved]).toEqual([0, 0]);
  });

  it('refuses to cancel a finished check', async () => {
    const h = setup();
    const { gradeId } = await h.service.grade(USER, 'rv_1');
    await expect(h.service.cancel(USER, gradeId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.service.cancel(USER, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('latest + re-check comparison', () => {
  it('returns the newest check, the previous one and staleness', async () => {
    const h = setup({ ai: false });
    expect(await h.service.latest(USER, 'rv_1')).toEqual({ grade: null, previous: null, stale: false, aiAvailable: false });
    const first = await h.service.grade(USER, 'rv_1');
    const weakIssue = first.grade!.issues.find((i) => i.type === 'weak_verb')!;
    await h.service.applyFix(USER, 'rv_1', weakIssue.id, 'Opened the store every morning.');
    let latest = await h.service.latest(USER, 'rv_1');
    expect(latest.stale).toBe(true);
    await h.service.grade(USER, 'rv_1');
    latest = await h.service.latest(USER, 'rv_1');
    expect(latest.stale).toBe(false);
    expect(latest.previous!.id).toBe(first.gradeId);
    expect(latest.previous!.issueTypes).toContain('weak_verb');
    expect(latest.grade!.counts!.critical).toBeLessThan(first.grade!.counts!.critical);
  });

  it('shows a long-running row as failed', async () => {
    const h = setup();
    h.store.grades.push({
      id: 'g_old', userId: USER, variantId: 'rv_1', contentHash: 'x', targetTitle: null, status: 'running', grade: null, score: null,
      counts: null, issues: null, model: null, creditLedgerId: null, createdAt: new Date(NOW.getTime() - 10 * 60_000), completedAt: null,
    });
    expect((await h.service.latest(USER, 'rv_1')).grade!.status).toBe('failed');
  });
});

describe('fixIssue', () => {
  it('returns an AI version, spends one rewrite credit and maps the variant to an action', async () => {
    const h = setup();
    const { grade } = await h.service.grade(USER, 'rv_1');
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    const res = await h.service.fixIssue(USER, 'rv_1', issue.id, { variant: 'stronger', instruction: 'Keep it short', idempotencyKey: 'f1' });
    expect(res).toEqual({ suggestions: [{ text: 'Opened the store every morning and ran the till.', aiWritten: true }], blocked: 0 });
    const call = h.rewrite.mock.calls[0]![0];
    expect(call).toMatchObject({ mode: 'bullet', action: 'confident', text: issue.target, instruction: 'Keep it short' });
    expect(call.resumeMarkdown).not.toMatch(/sam@example/);
    expect((await bucket(h.kit, 'rewrite')).used).toBe(1);
    expect(h.logAiLabel).not.toHaveBeenCalled(); // RoboApply
  });

  it('CitationGuard blocks invented numbers; the credit goes back', async () => {
    const h = setup();
    const { grade } = await h.service.grade(USER, 'rv_1');
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    h.rewrite.mockResolvedValueOnce({ rewrite: 'Opened the store for 300 customers a day.' });
    await expect(h.service.fixIssue(USER, 'rv_1', issue.id, { variant: 'ai' })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'citation_guard', blocked: 1 },
    });
    expect((await bucket(h.kit, 'rewrite')).used).toBe(0);
  });

  it('summary fixes may reuse numbers from the resume, and get three options', async () => {
    const h = setup();
    h.store.variants.set('rv_s', memoryVariant(USER, 'rv_s', GOOD_INTL.replace(/Backend engineer[^\n]+/, 'Engineer.')));
    const { grade } = await h.service.grade(USER, 'rv_s');
    const issue = grade!.issues.find((i) => i.type === 'summary_too_short')!;
    h.rewrite.mockResolvedValueOnce({ options: ['Engineer who built a ledger for 2M payments a day.', 'Engineer with 7 patents.', 'Engineer.'] });
    const res = await h.service.fixIssue(USER, 'rv_s', issue.id, { variant: 'longer' });
    expect(h.rewrite.mock.calls[0]![0]).toMatchObject({ mode: 'summary', action: 'expand' });
    expect(res.suggestions.map((s) => s.text)).toEqual(['Engineer who built a ledger for 2M payments a day.']);
    expect(res.blocked).toBe(1);
  });

  it('with AI consent off: 503 ai_unavailable and zero LLM calls', async () => {
    const h = setup();
    const { grade } = await h.service.grade(USER, 'rv_1');
    h.setAi(false);
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    await expect(h.service.fixIssue(USER, 'rv_1', issue.id, { variant: 'ai' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(h.rewrite).not.toHaveBeenCalled();
  });

  it('refuses issues without text to rewrite, and stale targets', async () => {
    const h = setup();
    h.store.variants.set('rv_n', memoryVariant(USER, 'rv_n', '## Experience\n- Responsible for opening the store.'));
    const { grade } = await h.service.grade(USER, 'rv_n');
    const contact = grade!.issues.find((i) => i.type === 'contact_email_missing')!;
    await expect(h.service.fixIssue(USER, 'rv_n', contact.id, { variant: 'ai' })).rejects.toMatchObject({ code: 'invalid_request' });
    const weak = grade!.issues.find((i) => i.type === 'weak_verb')!;
    h.store.variants.get('rv_n')!.resumeMarkdown = '## Experience\n- Opened the store.';
    await expect(h.service.fixIssue(USER, 'rv_n', weak.id, { variant: 'ai' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'target_changed' } });
    await expect(h.service.fixIssue(USER, 'rv_n', 'nope', { variant: 'ai' })).rejects.toBeInstanceOf(HttpError);
    expect(h.rewrite).not.toHaveBeenCalled();
  });

  it('a failed rewrite answers ai_unavailable and releases the credit', async () => {
    const h = setup();
    const { grade } = await h.service.grade(USER, 'rv_1');
    h.rewrite.mockRejectedValueOnce(new Error('timeout'));
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    await expect(h.service.fixIssue(USER, 'rv_1', issue.id, { variant: 'ai' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect((await bucket(h.kit, 'rewrite')).used).toBe(0);
  });

  it('logs the AI label on GoApply', async () => {
    const h = setup({ market: 'cn' });
    const { grade } = await h.service.grade(USER, 'rv_1');
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    h.logAiLabel.mockRejectedValueOnce(new Error('not implemented'));
    await expect(h.service.fixIssue(USER, 'rv_1', issue.id, { variant: 'ai' })).resolves.toMatchObject({ blocked: 0 });
    expect(h.logAiLabel).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, kind: 'resume_fix' }));
  });
});

describe('applyFix', () => {
  it('replaces the target text once and re-hashes the resume', async () => {
    const h = setup({ ai: false });
    const { grade } = await h.service.grade(USER, 'rv_1');
    const issue = grade!.issues.find((i) => i.type === 'weak_verb')!;
    const before = h.store.variants.get('rv_1')!.resumeContentHash;
    const res = await h.service.applyFix(USER, 'rv_1', issue.id, 'Opened the store\nevery morning.');
    expect(res.applied).toBe(true);
    expect(res.resumeContentHash).not.toBe(before);
    expect(h.store.variants.get('rv_1')!.resumeMarkdown).toContain('- Opened the store every morning.');
    await expect(h.service.applyFix(USER, 'rv_1', issue.id, 'Again')).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('keywordReport', () => {
  it('reads the job, its extraction and the fit row for this resume version', async () => {
    const h = setup();
    h.store.jobs.set('job_1', {
      id: 'job_1', title: 'Shop Assistant', descriptionPlain: 'Retail role.', qualifications: null, responsibilities: null,
      minYears: 1, educationLevel: null, skills: ['excel', 'inventory'],
    });
    h.store.jobs.set('job_private', { id: 'job_private', title: 'x', descriptionPlain: '', qualifications: null, responsibilities: null, minYears: null, educationLevel: null, skills: [], visibility: 'private', ownerUserId: 'other' });
    h.store.extractions.set('job_1', { keywords: [{ keyword: 'customer service', importance: 'high' }] });
    h.store.fitRows.push({ userId: USER, jobId: 'job_1', variantId: 'rv_1', score: 66, tier: 'good', generatedAt: NOW, resumeContentHashAtScore: h.store.variants.get('rv_1')!.resumeContentHash });
    const report = await h.service.keywordReport(USER, 'rv_1', { jobId: 'job_1' });
    expect(report.fit!.value).toBe(66);
    expect(report.hardSkills.matched).toEqual(['excel', 'inventory']);
    expect(report.keywords.matched).toEqual(['customer service']);
    await expect(h.service.keywordReport(USER, 'rv_1', { jobId: 'job_private' })).rejects.toMatchObject({ code: 'not_found' });
    expect(h.runAiPass).not.toHaveBeenCalled();
    expect(h.rewrite).not.toHaveBeenCalled();
  });
});

describe('onboarding grant', () => {
  it('grants one resume_check credit once', async () => {
    const h = setup();
    const grant = vi.spyOn(h.kit.credits, 'grant');
    const [a, b] = await Promise.all([h.service.grantOnboardingCheck(USER), h.service.grantOnboardingCheck(USER)]);
    expect([a, b].sort()).toEqual(['already_granted', 'granted']);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith({ userId: USER, bucket: 'resume_check', amount: 1, reason: 'onboarding_check' });
    expect(await h.service.grantOnboardingCheck(USER)).toBe('already_granted');
    expect(grant).toHaveBeenCalledTimes(1);
    expect((await bucket(h.kit, 'resume_check')).grantRemaining).toBe(1);
  });

  it('grants once when two server instances race (shared claim lock)', async () => {
    const h = setup();
    const grant = vi.spyOn(h.kit.credits, 'grant');
    // Two service instances = two processes; only the store (the database) is shared.
    const other = new ResumeCheckService({ ...h.deps });
    const results = await Promise.all([
      h.service.grantOnboardingCheck(USER),
      other.grantOnboardingCheck(USER),
      other.grantOnboardingCheck(USER),
      h.service.grantOnboardingCheck(USER),
    ]);
    expect(results.filter((r) => r === 'granted')).toHaveLength(1);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('a failed grant can be retried', async () => {
    const h = setup();
    const grant = vi.spyOn(h.kit.credits, 'grant').mockRejectedValueOnce(new Error('db down'));
    await expect(h.service.grantOnboardingCheck(USER)).rejects.toThrow('db down');
    expect(await h.service.grantOnboardingCheck(USER)).toBe('granted');
    expect(grant).toHaveBeenCalledTimes(2);
  });
});

describe('actionFor', () => {
  it('maps variants and issue types', () => {
    expect(actionFor('shorter', 'weak_verb')).toBe('shorten');
    expect(actionFor('longer', 'x')).toBe('expand');
    expect(actionFor('ai', 'no_numbers')).toBe('metrics');
    expect(actionFor('ai', 'summary_vague')).toBe('improve');
  });
});

describe('saved layout and the rule count (INT-10)', () => {
  it('a saved two-column template raises layout_columns, and the rule is part of the count', async () => {
    const h = setup({ ai: false });
    h.store.variants.set('rv_two', memoryVariant(USER, 'rv_two', GOOD_INTL, { template: 'two_column' }));
    const two = await h.service.grade(USER, 'rv_two');
    expect(two.grade!.issues.map((i) => i.type)).toContain('layout_columns');
    const one = await h.service.grade(USER, 'rv_good');
    expect(one.grade!.issues.map((i) => i.type)).not.toContain('layout_columns');
    // Same checklist for both: the template rule is checked either way.
    expect(two.grade!.rulesChecked).toBe(one.grade!.rulesChecked);
    expect(one.grade!.rulesChecked).toBe(rulesCountFor('intl', false));
  });

  it('text with no template (the signed-out free tool) leaves the template rule out of the count', async () => {
    const h = setup({ ai: false });
    const tool = new ResumeCheckService({ ...h.deps, hasTemplate: () => false });
    const res = await tool.grade(USER, 'rv_good');
    expect(res.grade!.rulesChecked).toBe(rulesCountFor('intl', false) - 1);
  });

  it('a service built without hasTemplate never counts the template rule (the count is never one too high)', async () => {
    const h = setup({ ai: false });
    const { hasTemplate: _omit, ...withoutTemplate } = h.deps;
    void _omit;
    const res = await new ResumeCheckService(withoutTemplate).grade(USER, 'rv_good');
    expect(res.grade!.rulesChecked).toBe(rulesCountFor('intl', false, { template: false }));
    expect(res.grade!.rulesChecked).toBe(rulesCountFor('intl', false) - 1);
  });

  it.each(['intl', 'cn'] as const)('the signed-out free tool (%s) reports the count without the template rule', async (profile) => {
    // features/tools builds its own ResumeCheckService over pasted text.
    const { runChecklist } = await import('../tools/checks.js');
    const r = await runChecklist(GOOD_INTL, profile, () => NOW);
    expect(r.rulesChecked).toBe(rulesCountFor(profile, false, { template: false }));
    expect(r.issues.map((i) => i.type)).not.toContain('layout_columns');
  });
});

describe('applyFix provenance (INT-10)', () => {
  it('stamps the resume as AI-assisted when an AI version is applied', async () => {
    const h = setup();
    const graded = await h.service.grade(USER, 'rv_1', { idempotencyKey: 'k-prov' });
    const issue = graded.grade!.issues.find((i) => i.fixable && i.target)!;
    expect(h.store.aiAssisted.has('rv_1')).toBe(false);
    await h.service.applyFix(USER, 'rv_1', issue.id, 'Opened the store every morning and ran the till.');
    expect(h.store.aiAssisted.has('rv_1')).toBe(true);
  });
});
