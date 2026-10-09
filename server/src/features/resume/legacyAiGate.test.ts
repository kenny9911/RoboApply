// @vitest-environment node
//
// WP-22: the legacy inline-AI endpoints (/v2/resumes/:id/rewrite and
// /tailor-diff, RAResumeAIService) honour the GoApply AI consent too: with
// aiAllowed(user)=false they throw before any agent runs (zero LLMService
// calls) and the route answers 503 ai_unavailable. Also covers the
// `resume.grade` worker payload rules.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chat, aiAllowedMock, agentRun } = vi.hoisted(() => ({ chat: vi.fn(), aiAllowedMock: vi.fn(async () => false), agentRun: vi.fn() }));
vi.mock('../../services/llm/LLMService.js', () => ({ llmService: { chat }, LLMService: class {} }));
vi.mock('../../lib/prisma.js', () => ({
  default: {
    rAResumeVariant: {
      findFirst: vi.fn(async () => ({ id: 'rv_1', userId: 'u1', resumeMarkdown: '## Experience\n- Built things.', deletedAt: null })),
    },
    rAJob: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../../platform/consent/aiAllowed.js', () => ({ aiAllowed: (...args: unknown[]) => aiAllowedMock(...(args as [])) }));
vi.mock('../../roboapply/v2/agents/RAResumeRewriteAgent.js', () => ({
  RAResumeRewriteAgent: class {
    run = agentRun;
  },
}));

import { AiUnavailableError, raResumeAIService } from '../../roboapply/v2/services/RAResumeAIService.js';
import { workers, RESUME_WORK_KINDS } from './workers.js';

describe('legacy inline AI gate', () => {
  beforeEach(() => {
    chat.mockClear();
    agentRun.mockClear();
  });

  it('rewrite: no consent → AiUnavailableError, zero agent and LLM calls', async () => {
    await expect(raResumeAIService.rewrite('u1', 'rv_1', { mode: 'bullet', text: 'Built things.', action: 'improve' })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(agentRun).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('tailorDiff: no consent → AiUnavailableError, zero LLM calls', async () => {
    await expect(raResumeAIService.tailorDiff('u1', 'rv_1', { jdText: 'Build things in Python.' })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('resume.grade worker', () => {
  const worker = workers.find((w) => w.kind === RESUME_WORK_KINDS.resumeGrade)!;
  const item = (payload: unknown, userId: string | null = 'u1') =>
    ({ id: 'wi_1', kind: 'resume.grade', brand: 'roboapply', userId, payload, attempts: 1, maxAttempts: 3, dedupeKey: null, priority: 0 }) as never;

  it('rejects malformed payloads permanently', async () => {
    await expect(worker.handler(item({}), {} as never)).rejects.toMatchObject({ name: 'PermanentWorkError' });
    await expect(worker.handler(item({ variantId: 'rv_1' }, null), {} as never)).rejects.toMatchObject({ name: 'PermanentWorkError' });
  });
});
