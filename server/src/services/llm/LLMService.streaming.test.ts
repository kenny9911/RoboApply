// @vitest-environment node
//
// streamChatWithTools against a fake OpenAI-compatible server on 127.0.0.1 (no
// external network): text deltas, a tool-call round, abort on signal, retry
// only before the first delta, GoApply on the shared stack (same provider and
// model as RoboApply) and on its own, the domestic-only wall as an opt-in, the
// GoApply content-safety gate on streamed output on every route, and the
// copilot startup check for both brands.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  keys: {} as Record<string, string>,
  baseUrls: {} as Record<string, string>,
  tuning: {} as Record<string, unknown>,
}));

vi.mock('../LoggerService.js', () => ({
  generateRequestId: () => 'req_stream',
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logLLMCall: vi.fn() },
}));
// The real brand predicate (isByokAllowedForBrand); only the key lookup is faked.
vi.mock('../../lib/byokService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/byokService.js')>()),
  resolveByok: vi.fn(async () => null),
  touchByok: vi.fn(),
}));
vi.mock('../../lib/llm/systemCredentials.js', () => ({
  resolveProviderCredential: (provider: string) => {
    const p = provider.toLowerCase();
    return { apiKey: state.keys[p] ?? '', baseUrl: state.baseUrls[p], tuning: state.tuning };
  },
}));

const { LLMService, assertCopilotModelSupportsTools } = await import('./LLMService.js');
const { LlmStreamInterruptedError, ToolsUnsupportedError } = await import('./errors.js');
const { buildStreamParams, createStreamingClient, toOpenAIMessages } = await import('./toolStreaming.js');
const { runWithBrand } = await import('../../lib/requestContext.js');
const safety = await import('../../platform/llm/contentSafety/index.js');
const routing = await import('./fallbackRouting.js');

/* ── Fake OpenAI-compatible server ─────────────────────────────────────── */

type Handler = (req: IncomingMessage & { body: Record<string, any> }, res: ServerResponse) => void | Promise<void>;
const requests: Array<{ path: string; body: Record<string, any>; auth?: string }> = [];
let handlers: Handler[] = [];
let server: Server;
let baseUrl = '';
const closedEarly: boolean[] = [];

function sse(res: ServerResponse, chunks: unknown[], opts: { done?: boolean } = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (opts.done !== false) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

const textChunk = (content: string) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { content } }] });
const finishChunk = (reason: string) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = { id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? '', body, auth: req.headers.authorization });
      const handler = handlers.shift();
      if (!handler) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no handler' } }));
        return;
      }
      res.on('close', () => closedEarly.push(!res.writableEnded));
      void handler(Object.assign(req, { body }), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ENV_NAMES = [
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_COPILOT_MODEL',
  'LLM_FALLBACK_MODEL',
  'CN_LLM_PROVIDER',
  'CN_LLM_MODEL',
  'CN_LLM_COPILOT_MODEL',
  'CN_LLM_DOMESTIC_HOSTS',
  'CN_LLM_DOMESTIC_ONLY',
  'CN_RESIDENCY_STRICT',
  'NODE_ENV',
  'ALLOWED_BRANDS',
  'BRAND_LOCK',
  'LLM_SETTINGS_DB_DISABLED',
  'LLM_RETRY_BASE_MS',
  'LLM_RETRY_MAX_MS',
  'LLM_RETRY_ATTEMPTS',
  'LLM_FALLBACK_AUTO',
  'MOCK_LLM',
];
let savedEnv: Record<string, string | undefined> = {};

/** Every model/provider variable of either brand that is set right now (a local .env may carry some). */
const llmEnvNames = () => Object.keys(process.env).filter((n) => /^(CN_)?LLM_/.test(n));

beforeEach(() => {
  const names = [...new Set([...ENV_NAMES, ...llmEnvNames()])];
  savedEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.LLM_SETTINGS_DB_DISABLED = 'true';
  process.env.LLM_RETRY_BASE_MS = '1';
  process.env.LLM_RETRY_MAX_MS = '2';
  process.env.LLM_FALLBACK_AUTO = 'false';
  // RoboApply: the copilot task on a new-api gateway that is the fake server.
  process.env.LLM_COPILOT_MODEL = 'newapi/fake-model';
  state.keys = { newapi: 'test-key' };
  state.baseUrls = { newapi: baseUrl };
  state.tuning = {};
  requests.length = 0;
  handlers = [];
  closedEarly.length = 0;
  routing.resetCircuits();
});

afterEach(() => {
  for (const n of new Set([...Object.keys(savedEnv), ...llmEnvNames()])) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
  safety.setContentSafetyProvider(null);
  safety.setContentSafetyEventWriter(null);
});

const tools = [
  {
    name: 'search_jobs',
    description: 'Search jobs',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  {
    name: 'get_current_filters',
    parameters: { type: 'object', properties: {} },
  },
];
const robo = <T>(fn: () => Promise<T>) => runWithBrand('roboapply', fn);
const go = <T>(fn: () => Promise<T>) => runWithBrand('goapply', fn);

describe('streamChatWithTools (OpenAI-compatible)', () => {
  it('streams text deltas in order and reports usage', async () => {
    handlers.push((_req, res) => sse(res, [textChunk('Hello'), textChunk(', '), textChunk('world.'), finishChunk('stop'), usageChunk]));
    const deltas: string[] = [];

    const result = await robo(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, maxTokens: 900, onDelta: (d) => deltas.push(d) }),
    );

    expect(deltas).toEqual(['Hello', ', ', 'world.']);
    expect(result).toMatchObject({
      content: 'Hello, world.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      model: 'fake-model',
      provider: 'newapi',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/v1/chat/completions');
    expect(requests[0].auth).toBe('Bearer test-key');
    expect(requests[0].body).toMatchObject({
      model: 'fake-model',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 900,
      tools: [
        { type: 'function', function: { name: 'search_jobs', description: 'Search jobs', parameters: tools[0].parameters } },
        { type: 'function', function: { name: 'get_current_filters', parameters: tools[1].parameters } },
      ],
    });
  });

  it('assembles a tool-call round and sends the results back on the next round', async () => {
    handlers.push((_req, res) =>
      sse(res, [
        { choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_jobs', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"data analyst"}' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_current_filters', arguments: '' } }] } }] },
        finishChunk('tool_calls'),
      ]),
    );
    handlers.push((req, res) => {
      const msgs = req.body.messages as Array<Record<string, any>>;
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      sse(res, [textChunk(`Found ${toolMsgs.length} results.`), finishChunk('stop')]);
    });

    const svc = new LLMService();
    const announced: string[] = [];
    const first = await robo(() =>
      svc.streamChatWithTools([{ role: 'user', content: 'find analyst jobs' }], {
        task: 'copilot',
        tools,
        onToolCall: (c) => announced.push(c.name),
      }),
    );

    expect(first.finishReason).toBe('tool_calls');
    expect(first.content).toBe('');
    expect(first.toolCalls).toEqual([
      { id: 'call_a', name: 'search_jobs', arguments: '{"q":"data analyst"}', parsedArguments: { q: 'data analyst' } },
      { id: 'call_b', name: 'get_current_filters', arguments: '', parsedArguments: {} },
    ]);
    expect(announced).toEqual(['search_jobs', 'get_current_filters']);

    const second = await robo(() =>
      svc.streamChatWithTools(
        [
          { role: 'user', content: 'find analyst jobs' },
          { role: 'assistant', content: null, toolCalls: first.toolCalls },
          { role: 'tool', toolCallId: 'call_a', content: '{"jobs":[]}' },
          { role: 'tool', toolCallId: 'call_b', content: '{"filters":{}}' },
        ],
        { task: 'copilot', tools },
      ),
    );
    expect(second.content).toBe('Found 2 results.');
    const sent = requests[1].body.messages as Array<Record<string, any>>;
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'search_jobs', arguments: '{"q":"data analyst"}' } },
        { id: 'call_b', type: 'function', function: { name: 'get_current_filters', arguments: '{}' } },
      ],
    });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: '{"jobs":[]}' });
  });

  it('reports malformed tool arguments instead of throwing', async () => {
    handlers.push((_req, res) =>
      sse(res, [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'search_jobs', arguments: '{"q": "unterminated' } }] } }] },
        finishChunk('tool_calls'),
      ]),
    );
    const result = await robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools }));
    expect(result.toolCalls[0]).toMatchObject({ name: 'search_jobs', argumentsError: expect.any(String) });
    expect(result.toolCalls[0].parsedArguments).toBeUndefined();
  });

  it('aborts on the signal mid-stream', async () => {
    handlers.push((_req, res) => sse(res, [textChunk('Partial')], { done: false })); // never finishes
    const controller = new AbortController();
    const deltas: string[] = [];

    const promise = robo(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], {
        task: 'copilot',
        tools,
        signal: controller.signal,
        onDelta: (d) => {
          deltas.push(d);
          controller.abort();
        },
      }),
    );

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(deltas).toEqual(['Partial']);
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(closedEarly).toContain(true));
  });

  it('retries a transient failure before the first delta', async () => {
    handlers.push((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Service unavailable' } }));
    });
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));

    const result = await robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }));
    expect(result.content).toBe('ok');
    expect(requests).toHaveLength(2);
  });

  it('never retries after a delta was emitted: the turn ends with LlmStreamInterruptedError', async () => {
    handlers.push((_req, res) => {
      sse(res, [textChunk('Half an ans')], { done: false });
      setTimeout(() => res.socket?.destroy(), 20);
    });
    handlers.push((_req, res) => sse(res, [textChunk('second attempt'), finishChunk('stop')]));
    const deltas: string[] = [];

    const caught = await robo(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, onDelta: (d) => deltas.push(d) }),
    ).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(LlmStreamInterruptedError);
    expect((caught as InstanceType<typeof LlmStreamInterruptedError>).partialContent).toBe('Half an ans');
    expect(deltas).toEqual(['Half an ans']);
    expect(requests).toHaveLength(1);
  });

  it('hands the credential timeout tuning to the streaming client', async () => {
    state.tuning = { timeoutMs: 12_345 };
    const seen: Array<Record<string, unknown>> = [];
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));

    await robo(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], {
        task: 'copilot',
        tools,
        clientFactory: (providerType, cred) => {
          seen.push(cred);
          return createStreamingClient(providerType, cred);
        },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ timeoutMs: 12_345 });
  });

  it('returns the streamed reasoning_content without emitting it', async () => {
    const deltas: string[] = [];
    handlers.push((_req, res) =>
      sse(res, [
        { id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { reasoning_content: 'Need to ' } }] },
        { id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { reasoning_content: 'search.' } }] },
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'fake-model',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_jobs', arguments: '{"q":"pm"}' } }] } }],
        },
        finishChunk('tool_calls'),
      ]),
    );

    const result = await robo(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, onDelta: (d) => deltas.push(d) }),
    );

    expect(result.reasoningContent).toBe('Need to search.');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['search_jobs']);
    expect(deltas).toEqual([]);
  });

  it('refuses Google and Anthropic with ToolsUnsupportedError (no request sent)', async () => {
    for (const model of ['google/gemini-3.8-flash', 'anthropic/claude-sonnet-4-6']) {
      await expect(
        robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, model })),
      ).rejects.toBeInstanceOf(ToolsUnsupportedError);
    }
    expect(requests).toHaveLength(0);
  });

  it('applies the RoboApply egress rule to streaming too', async () => {
    await expect(
      robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, model: 'deepseek/deepseek-v4-flash' })),
    ).rejects.toMatchObject({ code: 'brand_policy', policyCode: 'mainland_endpoint_for_intl' });
  });
});

describe('streamChatWithTools on GoApply with only the shared env (D5)', () => {
  const passAll = () =>
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: vi.fn(async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' })),
      checkOutput: vi.fn(async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' })),
    });

  it('streams from the same provider and model as RoboApply (the shared copilot model)', async () => {
    passAll();
    safety.setContentSafetyEventWriter(async () => {});
    const stream = (res: ServerResponse) => sse(res, [textChunk('Hello'), textChunk(' there.'), finishChunk('stop'), usageChunk]);
    handlers.push((_req, res) => stream(res), (_req, res) => stream(res));

    const goResult = await go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, maxTokens: 900 }));
    const roboResult = await robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, maxTokens: 900 }));

    expect(goResult).toMatchObject({ content: 'Hello there.', model: 'fake-model', provider: 'newapi', finishReason: 'stop' });
    expect({ ...goResult }).toEqual({ ...roboResult });
    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe(requests[1].path);
    expect(requests[0].auth).toBe(requests[1].auth);
    expect(requests[0].body).toEqual(requests[1].body);
  });

  it('tool streaming works on the shared model too: the tool call reaches onToolCall after the content-safety check', async () => {
    passAll();
    safety.setContentSafetyEventWriter(async () => {});
    handlers.push((_req, res) =>
      sse(res, [
        { id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_jobs', arguments: '{"q":"' } }] } }] },
        { id: 'c1', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'designer"}' } }] } }] },
        finishChunk('tool_calls'),
      ]),
    );
    const calls: string[] = [];
    const result = await go(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: '找设计师的工作' }], { task: 'copilot', tools, onToolCall: (c) => calls.push(`${c.name} ${c.arguments}`) }),
    );
    expect(result.finishReason).toBe('tool_calls');
    expect(calls).toEqual(['search_jobs {"q":"designer"}']);
    expect(requests[0].body.model).toBe('fake-model');
  });

  it('a missing copilot and default model is a configuration error, as on RoboApply (never ai_unavailable)', async () => {
    delete process.env.LLM_COPILOT_MODEL;
    const stream = () => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools });
    const goErr = await go(stream).catch((e: unknown) => e);
    const roboErr = await robo(stream).catch((e: unknown) => e);
    expect((goErr as Error).message).toMatch(/No LLM model is configured for task "copilot"/);
    expect((goErr as Error).message).toBe((roboErr as Error).message);
    expect(goErr).not.toMatchObject({ code: 'ai_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('behind the wall (CN_LLM_DOMESTIC_ONLY=true) the shared model is no fallback: ai_unavailable, nothing is sent', async () => {
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    const caught = await go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools })).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'ai_unavailable', status: 503, reason: 'no_model' });
    expect((caught as { detail?: string }).detail).toMatch(/CN_LLM_DOMESTIC_ONLY/);
    expect(requests).toHaveLength(0);
    // A gateway is not a mainland vendor by its name: the shared one is not borrowed even when its host is allowlisted...
    process.env.CN_LLM_DOMESTIC_HOSTS = '127.0.0.1';
    await expect(go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }))).rejects.toMatchObject({
      code: 'ai_unavailable',
      reason: 'no_model',
    });
    expect(requests).toHaveLength(0);
    // ...GoApply names it in its own settings, and then it streams.
    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.CN_LLM_MODEL = 'fake-model';
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));
    await go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }));
    expect(requests).toHaveLength(1);
    requests.length = 0;
    for (const n of ['CN_LLM_PROVIDER', 'CN_LLM_MODEL', 'CN_LLM_DOMESTIC_HOSTS']) delete process.env[n];
    // RoboApply is not behind GoApply's wall.
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));
    await robo(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }));
    expect(requests).toHaveLength(1);
  });
});

describe('streamChatWithTools on GoApply with a provider of its own', () => {
  beforeEach(() => {
    // A domestic new-api gateway (the fake server, allowlisted by host).
    process.env.CN_LLM_DOMESTIC_HOSTS = '127.0.0.1';
    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.CN_LLM_MODEL = 'fake-model';
  });

  it('answers ai_unavailable when its own stack has no model or no route, and sends nothing', async () => {
    const stream = () => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools });
    // A provider of its own and no model anywhere (neither its own nor the shared one).
    delete process.env.CN_LLM_MODEL;
    delete process.env.LLM_COPILOT_MODEL;
    await expect(go(stream)).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    // Its own default model as a bare id, and no provider of its own.
    process.env.CN_LLM_MODEL = 'fake-model';
    delete process.env.CN_LLM_PROVIDER;
    await expect(go(stream)).rejects.toMatchObject({ code: 'ai_unavailable', reason: 'no_model' });
    expect(requests).toHaveLength(0);
  });

  it('a task model it has not overridden is the shared copilot model, on the route it has for RoboApply', async () => {
    // CN default model set, CN copilot model unset: the shared LLM_COPILOT_MODEL (newapi/fake-model) is used.
    process.env.CN_LLM_MODEL = 'own-default-model';
    safety.setContentSafetyEventWriter(async () => {});
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));
    await go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }));
    expect(requests[0].body.model).toBe('fake-model');
    // Its own copilot model wins when set.
    process.env.CN_LLM_COPILOT_MODEL = 'own-copilot-model';
    handlers.push((_req, res) => sse(res, [textChunk('ok'), finishChunk('stop')]));
    await go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools }));
    expect(requests[1].body.model).toBe('own-copilot-model');
  });

  it('releases streamed text only after the content-safety check passed it', async () => {
    const order: string[] = [];
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: vi.fn(async () => {
        order.push('check:input');
        return { verdict: 'pass' as const, labels: [], provider: 'spy' };
      }),
      checkOutput: vi.fn(async (text: string) => {
        order.push(`check:${text}`);
        return { verdict: 'pass' as const, labels: [], provider: 'spy' };
      }),
    });
    handlers.push((_req, res) => sse(res, [textChunk('你好，'), textChunk('这是回答。'), finishChunk('stop')]));

    const result = await go(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: '帮我找工作' }], { task: 'copilot', tools, onDelta: (d) => order.push(`emit:${d}`) }),
    );

    expect(result.content).toBe('你好，这是回答。');
    expect(order[0]).toBe('check:input');
    // Every emitted piece was checked first.
    const emitted = order.filter((o) => o.startsWith('emit:')).map((o) => o.slice(5)).join('');
    expect(emitted).toBe('你好，这是回答。');
    const firstEmit = order.findIndex((o) => o.startsWith('emit:'));
    expect(order.slice(1, firstEmit).some((o) => o.startsWith('check:'))).toBe(true);
  });

  it('a retry after a held-back partial delta emits the second attempt exactly once', async () => {
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
    });
    // Attempt 1: a short delta (held by the gate, never shown), then the
    // connection drops before the stream ends.
    handlers.push((_req, res) => {
      sse(res, [textChunk('Hello, this is')], { done: false });
      setTimeout(() => res.socket?.destroy(), 20);
    });
    handlers.push((_req, res) => sse(res, [textChunk('Hello, this is a full answer.'), finishChunk('stop')]));
    const deltas: string[] = [];

    const result = await go(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'hi' }], { task: 'copilot', tools, onDelta: (d) => deltas.push(d) }),
    );

    expect(requests).toHaveLength(2);
    expect(deltas.join('')).toBe('Hello, this is a full answer.');
    expect(result.content).toBe(deltas.join(''));
  });

  it('checks tool-call arguments too: a blocked argument never reaches onToolCall', async () => {
    const checked: string[] = [];
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async (text: string) => {
        checked.push(text);
        return { verdict: text.includes('违禁') ? ('block' as const) : ('pass' as const), labels: [], provider: 'spy' };
      },
    });
    handlers.push((_req, res) =>
      sse(res, [
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'fake-model',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_jobs', arguments: '{"q":"违禁"}' } }] } }],
        },
        finishChunk('tool_calls'),
      ]),
    );
    const onToolCall = vi.fn();

    await expect(
      go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onToolCall })),
    ).rejects.toMatchObject({ code: 'content_blocked' });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(checked).toEqual(['search_jobs {"q":"违禁"}']);
  });

  it('a checker failure on tool arguments fails closed (ai_unavailable), no tool call announced', async () => {
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async () => {
        throw new Error('checker down');
      },
    });
    handlers.push((_req, res) =>
      sse(res, [
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          model: 'fake-model',
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_current_filters', arguments: '{}' } }] } }],
        },
        finishChunk('tool_calls'),
      ]),
    );
    const onToolCall = vi.fn();

    await expect(
      go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onToolCall })),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('a blocked output never reaches onDelta', async () => {
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async (text: string) => ({ verdict: text.includes('违禁') ? ('block' as const) : ('pass' as const), labels: [], provider: 'spy' }),
    });
    handlers.push((_req, res) => sse(res, [textChunk('违禁内容'), finishChunk('stop')]));
    const deltas: string[] = [];

    await expect(
      go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onDelta: (d) => deltas.push(d) })),
    ).rejects.toMatchObject({ code: 'content_blocked' });
    expect(deltas).toEqual([]);
  });
});

describe('streamChatWithTools on GoApply uses the WP-24 stream guard', () => {
  beforeEach(() => {
    process.env.CN_LLM_DOMESTIC_HOSTS = '127.0.0.1';
    process.env.CN_LLM_PROVIDER = 'newapi';
    process.env.CN_LLM_MODEL = 'fake-model';
  });

  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  it('writes ONE output event row per stream (not one per segment), hashing the whole reply', async () => {
    const rows: Array<{ direction: string; verdict: string; matched: { textLength: number; segments?: number } }> = [];
    safety.setContentSafetyEventWriter(async (row) => void rows.push(row as never));
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
    });
    const reply = words(200); // well over two 300-character segments
    const deltas = reply.match(/.{1,37}/gs) ?? [];
    handlers.push((_req, res) => sse(res, [...deltas.map(textChunk), finishChunk('stop')]));
    const out: string[] = [];

    const result = await go(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onDelta: (d) => out.push(d) }),
    );

    expect(result.content).toBe(reply);
    expect(out.join('')).toBe(reply);
    const outputRows = rows.filter((r) => r.direction === 'output');
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0]).toMatchObject({ verdict: 'pass', matched: { textLength: reply.length } });
    expect(outputRows[0].matched.segments).toBeGreaterThan(1);
  });

  it('never checks a segment that ends inside a Latin word (no "ass" from "assignment")', async () => {
    const checked: string[] = [];
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async (text: string) => {
        checked.push(text);
        return { verdict: /\bass\b/.test(text) ? ('block' as const) : ('pass' as const), labels: [], provider: 'spy' };
      },
    });
    // The 300-character release point falls inside "assignment".
    const head = 'x'.repeat(297) + ' ';
    const reply = `${head}assignment done.`;
    handlers.push((_req, res) => sse(res, [textChunk(`${head}ass`), textChunk('ignment done.'), finishChunk('stop')]));
    const out: string[] = [];

    const result = await go(() =>
      new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onDelta: (d) => out.push(d) }),
    );

    expect(result.content).toBe(reply);
    expect(out.join('')).toBe(reply);
    expect(checked.length).toBeGreaterThan(1);
  });

  it('runs the final whole-reply keyword scan: a block in finish() stops the stream', async () => {
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      keywordProvider: {
        id: 'kw',
        checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'kw' }),
        checkOutput: async (text: string) => ({
          verdict: text.includes('违禁') ? ('block' as const) : ('pass' as const),
          labels: ['kw'],
          provider: 'kw',
        }),
      },
    } as never);
    handlers.push((_req, res) => sse(res, [textChunk('违禁'), finishChunk('stop')]));
    const out: string[] = [];

    await expect(
      go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onDelta: (d) => out.push(d) })),
    ).rejects.toMatchObject({ code: 'content_blocked' });
  });

  it('maps a checker failure inside the guard to ai_unavailable (content_safety_unavailable)', async () => {
    safety.setContentSafetyProvider({
      id: 'spy',
      checkInput: async () => ({ verdict: 'pass' as const, labels: [], provider: 'spy' }),
      checkOutput: async () => {
        throw new Error('checker down');
      },
    });
    handlers.push((_req, res) => sse(res, [textChunk('hello'), finishChunk('stop')]));
    const out: string[] = [];

    await expect(
      go(() => new LLMService().streamChatWithTools([{ role: 'user', content: 'x' }], { task: 'copilot', tools, onDelta: (d) => out.push(d) })),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(out).toEqual([]);
  });
});

describe('buildStreamParams (vendor quirks)', () => {
  const base = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxTokens: 500 };

  it('adds reasoning headroom only when a domestic thinking mode is ON', () => {
    expect(buildStreamParams({ ...base, providerType: 'qwen', thinkingMode: 'enabled' })).toMatchObject({ enable_thinking: true, max_tokens: 8500 });
    expect(buildStreamParams({ ...base, providerType: 'qwen', thinkingMode: 'disabled' })).toMatchObject({ enable_thinking: false, max_tokens: 500 });
    expect(buildStreamParams({ ...base, providerType: 'glm', thinkingMode: 'enabled' })).toMatchObject({ thinking: { type: 'enabled' }, max_tokens: 8500 });
    expect(buildStreamParams({ ...base, providerType: 'doubao' })).toMatchObject({ max_tokens: 500 });
    expect(buildStreamParams({ ...base, providerType: 'doubao' }).thinking).toBeUndefined();
  });

  it('gives DeepSeek V4 thinking headroom and drops temperature', () => {
    const p = buildStreamParams({ ...base, providerType: 'deepseek', model: 'deepseek-v4-pro', temperature: 0.3 });
    expect(p).toMatchObject({ thinking: { type: 'enabled' }, max_tokens: 8500 });
    expect(p.temperature).toBeUndefined();
    expect(buildStreamParams({ ...base, providerType: 'deepseek', model: 'deepseek-v4-flash', thinkingMode: 'disabled', temperature: 0.3 })).toMatchObject({
      thinking: { type: 'disabled' },
      max_tokens: 500,
      temperature: 0.3,
    });
  });

  it('sends DeepSeek and Kimi the previous round\'s reasoning_content, and nobody else', () => {
    const turn = [
      { role: 'user' as const, content: 'find PM jobs' },
      {
        role: 'assistant' as const,
        content: null,
        reasoningContent: 'Need to search.',
        toolCalls: [{ id: 'call_1', name: 'search_jobs', arguments: '{"q":"pm"}' }],
      },
      { role: 'tool' as const, toolCallId: 'call_1', content: '[]' },
    ];
    for (const providerType of ['deepseek', 'kimi', 'moonshot']) {
      const p = buildStreamParams({ ...base, providerType, model: 'deepseek-v4-pro', messages: turn });
      expect((p.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ role: 'assistant', reasoning_content: 'Need to search.' });
    }
    for (const providerType of ['openai', 'openrouter', 'newapi', 'qwen']) {
      const msgs = toOpenAIMessages(turn, providerType);
      expect(msgs[1]).not.toHaveProperty('reasoning_content');
    }
  });

  it('tells OpenRouter never to use a mainland-China upstream', () => {
    expect(buildStreamParams({ ...base, providerType: 'openrouter' }).provider).toEqual({
      ignore: expect.arrayContaining(['deepseek', 'alibaba', 'baidu', 'streamlake']),
    });
    expect(buildStreamParams({ ...base, providerType: 'newapi' }).provider).toBeUndefined();
  });

  it('omits stream_options for Ollama', () => {
    expect(buildStreamParams({ ...base, providerType: 'ollama' }).stream_options).toBeUndefined();
    expect(buildStreamParams({ ...base, providerType: 'openrouter' }).stream_options).toEqual({ include_usage: true });
  });
});

describe('assertCopilotModelSupportsTools (startup check per brand)', () => {
  it('passes a shared tool-capable copilot model for both brands: GoApply is checked like RoboApply, not skipped', () => {
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const results = assertCopilotModelSupportsTools({ brands: ['roboapply', 'goapply'] });
    expect(results.map((r) => [r.brand, r.ok, r.skipped ?? null, r.route.selector, r.route.providerType])).toEqual([
      ['roboapply', true, null, 'openrouter/openai/gpt-6-luna', 'openrouter'],
      ['goapply', true, null, 'openrouter/openai/gpt-6-luna', 'openrouter'],
    ]);
  });

  it('a production boot with no deployment scope checks both brands and passes on the shared copilot model', () => {
    process.env.NODE_ENV = 'production';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const results = assertCopilotModelSupportsTools();
    expect(results.map((r) => [r.brand, r.ok])).toEqual([
      ['roboapply', true],
      ['goapply', true],
    ]);
    // Only the default model set: the copilot task inherits it on both brands.
    delete process.env.LLM_COPILOT_MODEL;
    process.env.LLM_MODEL = 'openrouter/openai/gpt-6-luna';
    expect(assertCopilotModelSupportsTools().every((r) => r.ok && r.route.inheritsDefault)).toBe(true);
  });

  it('fails loudly when the copilot model is Google or Anthropic, for GoApply too', () => {
    process.env.LLM_COPILOT_MODEL = 'google/gemini-3.8-flash';
    expect(() => assertCopilotModelSupportsTools({ brands: ['roboapply'] })).toThrow(ToolsUnsupportedError);
    expect(() => assertCopilotModelSupportsTools({ brands: ['goapply'] })).toThrow(ToolsUnsupportedError);
    const report = assertCopilotModelSupportsTools({ brands: ['roboapply', 'goapply'], throwOnError: false });
    expect(report.map((r) => [r.brand, r.ok])).toEqual([
      ['roboapply', false],
      ['goapply', false],
    ]);
  });

  it('fails loudly when no copilot or default model is configured: GoApply is no longer skipped', () => {
    delete process.env.LLM_COPILOT_MODEL;
    const report = assertCopilotModelSupportsTools({ brands: ['roboapply', 'goapply'], throwOnError: false });
    expect(report.map((r) => [r.brand, r.ok, r.problem])).toEqual([
      ['roboapply', false, 'no copilot or default model configured'],
      ['goapply', false, 'no copilot or default model configured'],
    ]);
  });

  it('an international GoApply copilot model is fine by default and breaks the brand policy only behind the wall', () => {
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.CN_LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    expect(assertCopilotModelSupportsTools({ brands: ['goapply'] })[0]).toMatchObject({ ok: true, brand: 'goapply' });

    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    const report = assertCopilotModelSupportsTools({ brands: ['goapply'], throwOnError: false });
    expect(report[0]).toMatchObject({ ok: false, brand: 'goapply' });
    expect(() => assertCopilotModelSupportsTools({ brands: ['goapply'] })).toThrow(/goapply/);
    // Its own domestic copilot model passes behind the wall.
    process.env.CN_LLM_COPILOT_MODEL = 'deepseek/deepseek-v4-flash';
    expect(assertCopilotModelSupportsTools({ brands: ['goapply'] })[0]).toMatchObject({ ok: true });
  });

  it('behind the wall a shared copilot model does not shadow GoApply\'s own mainland default: both brands pass the boot check', () => {
    process.env.NODE_ENV = 'production';
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    process.env.CN_LLM_PROVIDER = 'deepseek';
    process.env.CN_LLM_MODEL = 'deepseek-v4-flash';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna'; // RoboApply's, set for the whole deployment
    const results = assertCopilotModelSupportsTools(); // throws on any failure
    expect(results.map((r) => [r.brand, r.ok, r.skipped ?? null, r.route.selector, r.route.providerType, r.route.allowed])).toEqual([
      ['roboapply', true, null, 'openrouter/openai/gpt-6-luna', 'openrouter', true],
      ['goapply', true, null, 'deepseek-v4-flash', 'deepseek', true],
    ]);
    expect(results[1].route).toMatchObject({ inheritsDefault: true, source: 'env', sharedWalledOff: 'openrouter/openai/gpt-6-luna' });
    // The strict residency switch implies the wall.
    delete process.env.CN_LLM_DOMESTIC_ONLY;
    process.env.CN_RESIDENCY_STRICT = 'true';
    expect(assertCopilotModelSupportsTools().map((r) => [r.brand, r.ok, r.route.providerType])).toEqual([
      ['roboapply', true, 'openrouter'],
      ['goapply', true, 'deepseek'],
    ]);
  });

  it('behind the wall with no mainland model GoApply is skipped (its AI answers 503); RoboApply still boots', () => {
    process.env.NODE_ENV = 'production';
    process.env.CN_LLM_DOMESTIC_ONLY = 'true';
    process.env.LLM_COPILOT_MODEL = 'openrouter/openai/gpt-6-luna';
    const results = assertCopilotModelSupportsTools(); // no throw
    expect(results.map((r) => [r.brand, r.ok, r.skipped ?? null])).toEqual([
      ['roboapply', true, null],
      ['goapply', true, 'no mainland model behind the domestic-only wall (AI unavailable)'],
    ]);
    expect(results[1].route).toMatchObject({ selector: null, sharedWalledOff: 'openrouter/openai/gpt-6-luna' });
    // Without the wall a brand with no model at all is still a failure, never a skip.
    delete process.env.CN_LLM_DOMESTIC_ONLY;
    for (const n of ['LLM_COPILOT_MODEL', 'LLM_MODEL']) delete process.env[n];
    expect(assertCopilotModelSupportsTools({ throwOnError: false }).map((r) => [r.brand, r.ok, r.skipped ?? null])).toEqual([
      ['roboapply', false, null],
      ['goapply', false, null],
    ]);
  });
});
