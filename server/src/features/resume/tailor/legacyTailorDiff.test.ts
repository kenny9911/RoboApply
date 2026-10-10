// @vitest-environment node
//
// WP-36a carry-over (WP-22): the deprecated /v2/resumes/:id/tailor-diff path
// sends `resumeForLlm(base)` (no name or contact line) to the tailor agent,
// puts the header back afterwards, and answers null scores instead of a
// pseudo-score when no real fit score exists (D3).

import { describe, expect, it, vi } from 'vitest';

const { agentRun } = vi.hoisted(() => ({ agentRun: vi.fn() }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat: vi.fn(), getModel: () => 'm' }, LLMService: class {} }));
vi.mock('../../../lib/prisma.js', () => ({
  default: {
    rAResumeVariant: {
      findFirst: vi.fn(async () => ({
        id: 'rv_1',
        userId: 'u1',
        resumeContentHash: 'h',
        resumeMarkdown: '# Sam Lee\n*sam@example.test · +1 415 555 0100*\n## Experience\n- Built reports in SQL.\n',
        deletedAt: null,
      })),
    },
    rAJob: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../../../platform/consent/aiAllowed.js', () => ({ aiAllowed: async () => true }));
vi.mock('../../../platform/flags.js', () => ({ isEnabled: async () => true }));
vi.mock('../../../lib/matchBilling.js', () => ({ writeDeductionLog: vi.fn(async () => undefined) }));
vi.mock('../../../roboapply/v2/agents/RAResumeTailorAgent.js', () => ({
  RAResumeTailorAgent: class {
    run = agentRun;
  },
}));

import { raResumeAIService } from '../../../roboapply/v2/services/RAResumeAIService.js';

describe('legacy tailorDiff (deprecated)', () => {
  it('strips the contact header from the prompt, restores it after, and never invents scores', async () => {
    agentRun.mockResolvedValueOnce({
      tailoredResumeMarkdown: '## Experience\n- Built weekly reports in SQL for the sales team.\n',
      changeSummary: 'Reworded.',
      citationsByLine: {},
      citationGuardPassed: true,
      citationGuardViolations: [],
    });
    const out = await raResumeAIService.tailorDiff('u1', 'rv_1', { jdText: 'Analyst role building SQL reports for sales.' });
    const input = agentRun.mock.calls[0]![0] as { baseResumeMarkdown: string };
    expect(input.baseResumeMarkdown).not.toContain('Sam Lee');
    expect(input.baseResumeMarkdown).not.toContain('sam@example.test');
    expect(out.tailoredResumeMarkdown.startsWith('# Sam Lee\n*sam@example.test')).toBe(true);
    expect(out.tailoredResumeMarkdown).toContain('Built weekly reports in SQL for the sales team.');
    expect(out.diff).toMatchObject({ matchBefore: null, matchAfter: null, estimated: false });
  });
});
