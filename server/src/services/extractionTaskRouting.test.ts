import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  getTaskModel: vi.fn<() => string | undefined>(),
  getTaskReasoningEffort: vi.fn<() => 'medium' | undefined>(),
  getProviderSetting: vi.fn<() => string | undefined>(),
}));

vi.mock('../lib/llm/llmTaskSettings.js', () => ({
  getTaskModel: mocks.getTaskModel,
  getTaskReasoningEffort: mocks.getTaskReasoningEffort,
}));

vi.mock('../lib/llm/llmModels.js', () => ({
  getProviderSetting: mocks.getProviderSetting,
}));

vi.mock('../lib/llm/systemCredentials.js', () => ({
  resolveProviderCredential: vi.fn(() => ({
    apiKey: '',
    tuning: {},
    source: 'env',
  })),
}));

vi.mock('./llm/LLMService.js', () => {
  class LLMService {
    chat(messages: unknown, options?: unknown) {
      return mocks.chat(messages, options);
    }

    getProvider() {
      return 'openrouter';
    }
  }

  return { LLMService, llmService: new LLMService() };
});

vi.mock('./llm/withRetry.js', () => ({
  withLLMRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('./LoggerService.js', () => ({
  generateRequestId: () => 'test-request',
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    logLanguageDetection: vi.fn(),
    logLLMCall: vi.fn(),
    getRequestSnapshot: vi.fn(() => null),
  },
}));

import { ResumeParseAgent } from '../agents/ResumeParseAgent.js';
import { PDFService } from './PDFService.js';
import { ResumeParserService } from './ResumeParserService.js';
import { generateResumeSummaryHighlight } from './ResumeSummaryService.js';

const MODEL = 'openrouter/openai/gpt-5.6-luna';

describe('file-extraction task routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTaskModel.mockReturnValue(MODEL);
    mocks.getTaskReasoningEffort.mockReturnValue('medium');
    mocks.getProviderSetting.mockReturnValue('openrouter');
  });

  it('routes ResumeParseAgent through the extraction model and effort', async () => {
    mocks.chat.mockResolvedValue(JSON.stringify({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '',
      skills: ['Mathematics'],
      experience: [],
      education: [],
    }));

    const agent = new ResumeParseAgent();
    await (agent as unknown as {
      parseOnce(text: string, requestId?: string): Promise<unknown>;
    }).parseOnce('Ada Lovelace\nada@example.com');

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        model: MODEL,
        reasoningEffort: 'medium',
      }),
    );
  });

  it('routes every legacy ResumeParserService LLM call through the extraction settings', async () => {
    const service = new ResumeParserService();
    mocks.chat
      .mockResolvedValueOnce(JSON.stringify({
        candidateName: 'Ada Lovelace',
        contact: {},
        education: [],
        experience: [],
        projects: [],
        skills: [],
      }))
      .mockResolvedValueOnce('# Ada Lovelace\n\n## Experience')
      .mockResolvedValueOnce(`# Ada Lovelace\n\n${'Analytical Engine. '.repeat(10)}`);

    const parsed = await service.parseResumeStructured('Ada Lovelace');
    await service.formatResumeMarkdown(parsed);
    await service.parseAndFormatResume('Ada Lovelace');

    expect(mocks.chat).toHaveBeenCalledTimes(3);
    for (const [, options] of mocks.chat.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        model: MODEL,
        reasoningEffort: 'medium',
      }));
    }
  });

  it('routes the ingest summary call through the extraction settings', async () => {
    mocks.chat.mockResolvedValue(JSON.stringify({
      summary: 'Pioneering mathematician known for foundational computing work.',
      highlight: 'Foundational computing pioneer',
    }));

    await generateResumeSummaryHighlight({
      name: 'Ada Lovelace',
      email: '',
      phone: '',
      skills: ['Mathematics'],
      experience: [],
      education: [],
    });

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        model: MODEL,
        reasoningEffort: 'medium',
      }),
    );
  });

  it('routes image OCR through the extraction settings without a vision-model override', async () => {
    mocks.chat.mockResolvedValue('Ada Lovelace\nMathematician');

    await new PDFService().extractImage(Buffer.from('image bytes'), 'image/png');

    expect(mocks.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        model: MODEL,
        reasoningEffort: 'medium',
      }),
    );
    expect(mocks.chat.mock.calls[0]?.[1]).not.toHaveProperty('visionModel');
  });

  it('rejects a configured text-only extraction model instead of substituting a model', async () => {
    mocks.getTaskModel.mockReturnValue('deepseek/deepseek-v4-pro');

    await expect(
      new PDFService().extractImage(Buffer.from('image bytes'), 'image/png'),
    ).rejects.toThrow(
      'Configured extraction model "deepseek/deepseek-v4-pro" cannot process PDF/image input',
    );
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
