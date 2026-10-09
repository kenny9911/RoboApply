// Preparation failure classification: model-stack problems → llm_unavailable,
// everything else → prepare_failed.
// Run: npx vitest run server/src/interview-engine/prompt/llmFailure.test.ts

import { describe, expect, it } from 'vitest';
import { classifyPrepareError, InterviewLlmUnavailableError } from './llmFailure.js';

describe('classifyPrepareError', () => {
  it.each([
    ['dead OpenRouter key', new Error('401 User not found.')],
    ['wrapped dead key', new InterviewLlmUnavailableError('blueprint failed', { cause: new Error('401 User not found.') })],
    ['cause chain only', new Error('Agent failed', { cause: Object.assign(new Error('nope'), { status: 401 }) })],
    ['rate limit', Object.assign(new Error('Too Many Requests'), { status: 429 })],
    ['quota', new Error('You exceeded your current quota')],
    ['provider 5xx', Object.assign(new Error('upstream'), { status: 502 })],
    ['abort/timeout', Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' })],
    ['empty output', new Error('OpenRouter returned no content')],
    ['unparseable output', new Error('InterviewBlueprintAgent: unparseable response')],
    ['network', new Error('fetch failed')],
    [
      'LLMService LLMUnavailableError (billing, fallbacks tried, no status)',
      Object.assign(new Error('All LLM routes are unavailable for google/gemini'), {
        name: 'LLMUnavailableError',
        code: 'llm_unavailable',
        reason: 'billing',
        upstreamStatus: 400,
        attemptedFallbacks: ['anthropic/claude-sonnet-4-6'],
        cause: Object.assign(new Error('Your credit balance is too low to access the API'), { status: 400 }),
      }),
    ],
    [
      're-wrapped llm_unavailable code only',
      new Error('Agent failed', { cause: Object.assign(new Error('opaque'), { code: 'llm_unavailable' }) }),
    ],
    ['anthropic billing 400', Object.assign(new Error('400 Your credit balance is too low'), { status: 400 })],
  ])('%s → llm_unavailable', (_label, err) => {
    expect(classifyPrepareError(err)).toBe('llm_unavailable');
  });

  it.each([
    ['programming error', new TypeError("Cannot read properties of undefined (reading 'q')")],
    ['db error', new Error('Invalid `prisma.interviewSession.updateMany()` invocation: P2002 Unique constraint failed')],
    ['non-error', 'boom'],
    ['plain 400 validation', Object.assign(new Error('Invalid request'), { status: 400 })],
  ])('%s → prepare_failed', (_label, err) => {
    expect(classifyPrepareError(err)).toBe('prepare_failed');
  });
});
