// __tests__/fixtures/copilot — Assistant thread, message and stream (fictional data).
import type * as CP from '../../../lib/api/contracts/copilot';
import type { RequestFixture } from '../types';

export const thread = {
  id: 'th_fixture_1',
  title: null,
  contextJobId: 'job_fixture_1',
  updatedAt: '2026-10-09T00:00:00.000Z',
  createdAt: '2026-10-09T00:00:00.000Z',
} satisfies CP.ThreadView;

export const message = {
  id: 'msg_fixture_1',
  role: 'assistant',
  content: 'The post asks for GraphQL; your resume does not mention it.',
  cards: [],
  createdAt: '2026-10-09T00:00:01.000Z',
  feedback: null,
} satisfies CP.MessageView;

/** A complete SSE turn, as `postStream` delivers it. */
export const sseTurn: CP.CopilotSseEvent[] = [
  { event: 'meta', data: { threadId: thread.id, messageId: message.id } },
  { event: 'delta', data: { text: 'The post asks for GraphQL' } },
  { event: 'done', data: { messageId: message.id, usage: { inputTokens: 900, outputTokens: 40 }, creditsRemaining: 7 } },
];

export const copilotRequests: RequestFixture[] = [
  { contract: 'copilot', schema: 'SendMessageBodySchema', value: { text: 'What am I missing for this job?', contextJobId: 'job_fixture_1' } },
  { contract: 'copilot', schema: 'SendMessageBodySchema', value: { text: '   ' }, valid: false },
  { contract: 'copilot', schema: 'CreateThreadBodySchema', value: {} },
];
