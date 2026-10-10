// @vitest-environment node
//
// WP-36a: the tailor agent's prompt carries the session's sections, the
// user's instruction, only the confirmed keywords and the profile snapshot,
// and states the honesty rules (posting facts are never the candidate's own;
// headings and entry lines stay). Also the legacy tailor-diff score rule (D3:
// real fit scores or null, never an estimate). No model is called.

import { describe, expect, it, vi } from 'vitest';

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat, getModel: () => 'test-model' }, LLMService: class {} }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { RAResumeTailorAgent } from '../../../roboapply/v2/agents/RAResumeTailorAgent.js';
import { resolveTailorScores } from '../../../roboapply/v2/services/RAResumeAIService.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { TailorService } from './TailorService.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant } from './memoryStore.js';

type Exposed = { formatInput(input: unknown, locale?: string): string; getAgentPrompt(): string };

describe('RAResumeTailorAgent prompt (tailor sessions)', () => {
  const agent = new RAResumeTailorAgent() as unknown as Exposed;

  it('includes sections, instruction, confirmed keywords and the profile snapshot', () => {
    const text = agent.formatInput({
      baseResumeMarkdown: '## Experience\n- Built reports.',
      jobTitle: 'Analyst',
      companyName: 'Acme',
      jobDescription: 'Build dashboards.',
      complexity: 'standard',
      sections: ['experience', 'skills'],
      experienceDepth: 'quick',
      instruction: 'Lead with reporting.',
      confirmedKeywords: ['Tableau'],
      profileContext: 'Target: analyst roles.',
    });
    expect(text).toContain('## Sections you may change\n- experience\n- skills');
    expect(text).toContain('## Keywords the candidate confirmed they have\n- Tableau');
    expect(text).toContain("## The candidate's instruction (follow it unless it breaks a hard rule)\nLead with reporting.");
    expect(text).toContain('Target: analyst roles.');
    expect(text).toContain('## Experience: quick\nKeep every existing bullet.');
    expect(text).not.toContain('Keywords to address');
  });

  it('omits the optional blocks when they are empty', () => {
    const text = agent.formatInput({ baseResumeMarkdown: '- x', jobTitle: '', jobDescription: '', complexity: 'standard' });
    expect(text).not.toContain('Sections you may change');
    expect(text).not.toContain('confirmed');
    expect(text).not.toContain("candidate's instruction");
  });

  it('states the posting and structure rules', () => {
    const prompt = agent.getAgentPrompt();
    expect(prompt).toContain("Facts from the job posting are never the candidate's own");
    expect(prompt).toContain('Keywords the candidate confirmed');
    expect(prompt).toMatch(/Keep every `##` heading/);
  });
});

describe('legacy tailor-diff scores (D3)', () => {
  const rescore = vi.fn(async () => 81);

  it('a real cached base score and a re-score → both numbers, never estimated', async () => {
    await expect(resolveTailorScores({ cachedBase: 64, agentSucceeded: true, hasJobContext: true, rescoreTailored: rescore })).resolves.toEqual({
      matchBefore: 64,
      matchAfter: 81,
      estimated: false,
    });
  });

  it('no cached base, no job or a failed tailor → null, not a made-up number', async () => {
    rescore.mockClear();
    for (const opts of [
      { cachedBase: null, agentSucceeded: true, hasJobContext: true },
      { cachedBase: 70, agentSucceeded: false, hasJobContext: true },
      { cachedBase: 70, agentSucceeded: true, hasJobContext: false },
    ]) {
      await expect(resolveTailorScores({ ...opts, rescoreTailored: rescore })).resolves.toEqual({ matchBefore: null, matchAfter: null, estimated: false });
    }
    expect(rescore).not.toHaveBeenCalled();
  });

  it('a failed re-score → null', async () => {
    await expect(
      resolveTailorScores({ cachedBase: 70, agentSucceeded: true, hasJobContext: true, rescoreTailored: async () => Promise.reject(new Error('x')) }),
    ).resolves.toMatchObject({ matchBefore: null, matchAfter: null });
  });
});

describe('AI consent off (TASK_PLAN.md §2.2)', () => {
  it('zero LLMService calls with the real tailor agent wired in', async () => {
    const store = createMemoryTailorStore();
    store.variants.set('rv', memoryTailorVariant('u', 'rv', '## Skills\nSQL\n'));
    store.jobs.set('j', memoryTailorJob('j', { market: 'cn' }));
    const score = vi.fn();
    const svc = new TailorService({
      store,
      credits: createCreditTestKit().credits,
      aiAvailable: async () => false,
      market: () => 'cn',
      tailor: (input, options) => new RAResumeTailorAgent().run(input, options),
      profileContext: async () => null,
      score,
      markChecklist: async () => undefined,
      logAiLabel: async () => undefined,
      assertPhoneBound: async () => undefined,
    });
    await expect(
      svc.create('u', { baseVariantId: 'rv', jobId: 'j', mode: 'guided', sections: ['skills'], keywords: [], experienceDepth: 'quick' }),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(chat).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });
});
