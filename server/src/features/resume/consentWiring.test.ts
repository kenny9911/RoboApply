// @vitest-environment node
//
// WP-22: the production wiring of the resume check honours AI consent.
// `defaultResumeCheckDeps()` (aiAllowed AND isEnabled('ai.text')) is used as-is,
// with only the store and the credits swapped for in-memory twins: with no
// consent, grade() runs the checklist only and fixIssue() answers
// ai_unavailable, and LLMService is never called.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chat, aiAllowedMock, isEnabledMock } = vi.hoisted(() => ({
  chat: vi.fn(async () => {
    throw new Error('LLMService must not be called');
  }),
  aiAllowedMock: vi.fn(async (_userId: string) => false),
  isEnabledMock: vi.fn((_flag: string, _ctx?: unknown) => true),
}));

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/llm/LLMService.js', () => ({ llmService: { chat }, LLMService: class {} }));
vi.mock('../../platform/consent/aiAllowed.js', () => ({ aiAllowed: (userId: string) => aiAllowedMock(userId) }));
vi.mock('../../platform/flags.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/flags.js')>()),
  isEnabled: (flag: string, ctx?: unknown) => isEnabledMock(flag, ctx),
}));

import { createCreditTestKit } from '../../platform/credits/testkit.js';
import { defaultResumeCheckDeps, resumeAiAvailable } from './index.js';
import { ResumeCheckService } from './ResumeCheckService.js';
import { rulesCountFor } from './check/taxonomy.js';
import { createMemoryResumeCheckStore, memoryVariant } from './memoryStore.js';

const USER = 'u_consent';
const WEAK = '# Sam\n*sam@example.test · +1 415 555 0100*\n## Summary\nI recieve feedback well.\n## Experience\n- Responsible for opening the store.\n- Helped with inventory.';

function build() {
  const store = createMemoryResumeCheckStore();
  store.variants.set('rv_1', memoryVariant(USER, 'rv_1', WEAK));
  const kit = createCreditTestKit();
  const service = new ResumeCheckService({ ...defaultResumeCheckDeps(), store, credits: kit.credits });
  return { store, kit, service };
}

beforeEach(() => {
  chat.mockClear();
  aiAllowedMock.mockReset().mockResolvedValue(false);
  isEnabledMock.mockReset().mockReturnValue(true);
});

describe('resume check consent wiring (defaultResumeCheckDeps)', () => {
  it('no AI consent: grade() is checklist only and fixIssue() answers ai_unavailable, zero LLM calls', async () => {
    const { service, kit } = build();
    const { grade } = await service.grade(USER, 'rv_1');
    expect(grade!.status).toBe('done');
    expect(grade!.method).toBe('rules');
    // INT-10: the production wiring checks stored resumes, which always have a
    // template, so the template rule is part of the count.
    expect(defaultResumeCheckDeps().hasTemplate?.()).toBe(true);
    expect(grade!.rulesChecked).toBe(rulesCountFor('intl', false));
    expect(grade!.aiSkipped).toBe('ai_unavailable');
    expect(grade!.issues.some((i) => i.source === 'ai')).toBe(false);
    const weak = grade!.issues.find((i) => i.fixable)!;
    await expect(service.fixIssue(USER, 'rv_1', weak.id, { variant: 'ai' })).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(chat).not.toHaveBeenCalled();
    expect(aiAllowedMock).toHaveBeenCalledWith(USER);
    const usage = await kit.credits.usage(USER);
    expect(usage.find((u) => u.bucket === 'resume_check')!.used).toBe(0);
    expect((await service.latest(USER, 'rv_1')).aiAvailable).toBe(false);
  });

  it('consent given but the brand has no text model: still checklist only', async () => {
    aiAllowedMock.mockResolvedValue(true);
    isEnabledMock.mockImplementation((flag) => flag !== 'ai.text');
    expect(await resumeAiAvailable(USER)).toBe(false);
    const { service } = build();
    const { grade } = await service.grade(USER, 'rv_1');
    expect(grade!.method).toBe('rules');
    expect(chat).not.toHaveBeenCalled();
  });

  it('consent and model: AI is available', async () => {
    aiAllowedMock.mockResolvedValue(true);
    expect(await resumeAiAvailable(USER)).toBe(true);
    expect(isEnabledMock).toHaveBeenCalledWith('ai.text', { userId: USER });
  });
});
