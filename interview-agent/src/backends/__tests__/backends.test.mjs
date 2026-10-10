// WP-63b backend switch: LLM (gateway | openai_compatible) and speech
// (gateway | DashScope). Every constructor is injected; nothing reaches the
// network or the LiveKit gateway.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeLogger, tokenize, tts } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import {
  backendConfigProblems,
  buildLlm,
  buildSessionModels,
  buildStt,
  buildTts,
  describeBackends,
  interruptionFor,
  isDomesticHost,
  isGoApplyWorker,
  lifecyclePath,
  isWorkerConfigError,
  resolveLlmBackend,
  resolveOpenAiCompatibleRoute,
  resolveSttBackend,
  resolveTtsBackend,
  splitVendorModel,
  sttLanguage,
  WorkerConfigError,
} from '../../../dist/backends/index.js';
import { InterviewTtsFallback } from '../../../dist/tts-fallback.js';

initializeLogger({ pretty: false, level: 'silent' });

// ── LLM fakes ────────────────────────────────────────────────────────────────

function llmFactories() {
  const calls = { gateway: [], openaiCompatible: [] };
  return {
    calls,
    gateway: (opts) => { calls.gateway.push(opts); return { kind: 'gateway', opts }; },
    openaiCompatible: (opts) => { calls.openaiCompatible.push(opts); return { kind: 'openai_compatible', opts }; },
  };
}

test('LLM_BACKEND defaults to gateway (RoboApply worker) and rejects unknown values', () => {
  assert.equal(resolveLlmBackend({}), 'gateway');
  assert.equal(resolveLlmBackend({ LLM_BACKEND: ' OpenAI_Compatible ' }), 'openai_compatible');
  assert.throws(() => resolveLlmBackend({ LLM_BACKEND: 'azure' }), WorkerConfigError);
});

test('gateway backend is the pre-switch behaviour: metadata model + reasoning effort via LiveKit Inference', () => {
  const f = llmFactories();
  const built = buildLlm({ llm: { model: 'openai/gpt-5.4-mini', reasoningEffort: 'low' } }, {}, f);
  assert.equal(built.backend, 'gateway');
  assert.deepEqual(f.calls.gateway, [{ model: 'openai/gpt-5.4-mini', modelOptions: { reasoning_effort: 'low' } }]);
  assert.equal(f.calls.openaiCompatible.length, 0);

  // liveLlm overrides llm (contract C12), no effort → no modelOptions.
  const f2 = llmFactories();
  buildLlm({ llm: { model: 'a/b' }, liveLlm: { model: 'google/gemini-3-flash' } }, { DEEPSEEK_API_KEY: 'k' }, f2);
  assert.deepEqual(f2.calls.gateway, [{ model: 'google/gemini-3-flash' }]);
});

test('gateway backend keeps the original missing-model error', () => {
  assert.throws(
    () => buildLlm({}, {}, llmFactories()),
    /interview room metadata is missing llm\.model; configure LLM_INTERVIEW_LIVE_MODEL or LLM_INTERVIEW_MODEL/,
  );
});

test('openai_compatible: raw domestic model id → vendor base URL + key, prefix stripped, no reasoning effort', () => {
  const f = llmFactories();
  const built = buildLlm(
    { llm: { model: 'deepseek/deepseek-chat', reasoningEffort: 'low' } },
    { LLM_BACKEND: 'openai_compatible', DEEPSEEK_API_KEY: 'sk-ds' },
    f,
  );
  assert.equal(built.backend, 'openai_compatible');
  assert.equal(built.host, 'api.deepseek.com');
  assert.deepEqual(f.calls.openaiCompatible, [
    { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' },
  ]);
  assert.equal(f.calls.gateway.length, 0);
});

test('openai_compatible: vendor aliases and env base-URL overrides follow the control plane names', () => {
  const qwen = resolveOpenAiCompatibleRoute({ llm: { model: 'qwen/qwen-plus' } }, { DASHSCOPE_API_KEY: 'k' });
  assert.equal(qwen.baseURL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(qwen.model, 'qwen-plus');
  assert.equal(qwen.vendor, 'qwen');

  const glm = resolveOpenAiCompatibleRoute(
    { liveLlm: { model: 'GLM/glm-4.6' } },
    { GLM_API_KEY: 'k', GLM_API_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/' },
  );
  assert.equal(glm.baseURL, 'https://open.bigmodel.cn/api/paas/v4/');
  assert.equal(glm.model, 'glm-4.6');
  assert.equal(glm.source, 'liveLlm');

  const doubao = resolveOpenAiCompatibleRoute({ llm: { model: 'doubao/doubao-seed-1-6' } }, { ARK_API_KEY: 'k' });
  assert.equal(doubao.host, 'ark.cn-beijing.volces.com');
  const kimi = resolveOpenAiCompatibleRoute({ llm: { model: 'moonshot/kimi-k2' } }, { KIMI_API_KEY: 'k' });
  assert.equal(kimi.host, 'api.moonshot.cn');
  const minimax = resolveOpenAiCompatibleRoute({ llm: { model: 'minimax/MiniMax-M2' } }, { MINIMAX_API_KEY: 'k' });
  assert.equal(minimax.host, 'api.minimaxi.com');
});

test('openai_compatible: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are explicit overrides', () => {
  const route = resolveOpenAiCompatibleRoute(
    {},
    { LLM_MODEL: 'qwen/qwen-max', LLM_BASE_URL: 'https://llm.goapply.internal.cn/v1', LLM_API_KEY: 'gw', DOMESTIC_HOSTS: 'llm.goapply.internal.cn' },
  );
  assert.deepEqual(
    { model: route.model, baseURL: route.baseURL, apiKey: route.apiKey, source: route.source },
    { model: 'qwen-max', baseURL: 'https://llm.goapply.internal.cn/v1', apiKey: 'gw', source: 'env' },
  );
  // Metadata wins over LLM_MODEL.
  const meta = resolveOpenAiCompatibleRoute({ llm: { model: 'deepseek/deepseek-reasoner' } }, { LLM_MODEL: 'qwen/qwen-max', DEEPSEEK_API_KEY: 'k' });
  assert.equal(meta.model, 'deepseek-reasoner');
  // An unprefixed id is sent as-is and needs an explicit endpoint.
  assert.throws(() => resolveOpenAiCompatibleRoute({ llm: { model: 'my-model' } }, { LLM_API_KEY: 'k' }), /LLM_BASE_URL is required/);
  const raw = resolveOpenAiCompatibleRoute({ llm: { model: 'my-model' } }, { LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api.deepseek.com/v1' });
  assert.equal(raw.model, 'my-model');
  assert.equal(raw.vendor, null);
});

test('openai_compatible fails closed: foreign endpoint, missing key, missing model', () => {
  assert.throws(
    () => resolveOpenAiCompatibleRoute({ llm: { model: 'deepseek/deepseek-chat' } }, { DEEPSEEK_API_KEY: 'k', LLM_BASE_URL: 'https://openrouter.ai/api/v1' }),
    (err) => isWorkerConfigError(err) && /not a mainland endpoint/.test(err.message),
  );
  assert.throws(
    () => resolveOpenAiCompatibleRoute({ llm: { model: 'qwen/qwen-plus' } }, { DASHSCOPE_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', DASHSCOPE_API_KEY: 'k' }),
    /not a mainland endpoint/,
  );
  assert.throws(
    () => resolveOpenAiCompatibleRoute({ llm: { model: 'deepseek/deepseek-chat' } }, {}),
    /no API key for model "deepseek\/deepseek-chat": set LLM_API_KEY or DEEPSEEK_API_KEY/,
  );
  assert.throws(() => resolveOpenAiCompatibleRoute({}, { LLM_API_KEY: 'k' }), /missing llm\.model and LLM_MODEL is unset/);
});

test('openai_compatible builds the LiveKit OpenAI plugin client with the custom base URL (no request made)', () => {
  const built = buildLlm(
    { llm: { model: 'qwen/qwen-plus' } },
    { LLM_BACKEND: 'openai_compatible', DASHSCOPE_API_KEY: 'sk-test' },
  );
  assert.ok(built.llm instanceof openai.LLM);
  assert.equal(built.llm.model, 'qwen-plus');
  assert.equal(built.host, 'dashscope.aliyuncs.com');
  // Usage is reported as vendor/model, the control plane's cost-table id.
  assert.equal(built.llm.provider, 'qwen');

  const raw = buildLlm(
    { llm: { model: 'my-model' } },
    { LLM_BACKEND: 'openai_compatible', LLM_BASE_URL: 'https://gw.example.cn/v1', LLM_API_KEY: 'k', DOMESTIC_HOSTS: 'gw.example.cn' },
  );
  assert.equal(raw.llm.provider, 'gw.example.cn');
});

test('splitVendorModel only strips known domestic vendor prefixes', () => {
  assert.deepEqual(splitVendorModel('deepseek/deepseek-chat'), { vendor: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(splitVendorModel('openai/gpt-5'), { vendor: null, model: 'openai/gpt-5' });
  assert.deepEqual(splitVendorModel('qwen/'), { vendor: null, model: 'qwen/' });
});

test('domestic host allowlist mirrors the control plane (no dashscope-intl) plus DOMESTIC_HOSTS', () => {
  assert.equal(isDomesticHost('dashscope.aliyuncs.com', {}), true);
  assert.equal(isDomesticHost('dashscope-intl.aliyuncs.com', {}), false);
  assert.equal(isDomesticHost('ark.cn-beijing.volces.com', {}), true);
  assert.equal(isDomesticHost('api.openai.com', {}), false);
  assert.equal(isDomesticHost('gw.example.cn', { DOMESTIC_HOSTS: 'https://gw.example.cn, other.cn' }), true);
  assert.equal(isDomesticHost(null, {}), false);
});

// ── Speech fakes ─────────────────────────────────────────────────────────────

class FakeTts extends tts.TTS {
  label = 'fake.TTS';
  constructor(opts) { super(24000, 1, { streaming: true }); this.opts = opts; }
  stream() { throw new Error('not used'); }
  synthesize() { throw new Error('not used'); }
}

function speechFactories() {
  const calls = { gatewayStt: [], gatewayTts: [], openaiFloor: [], loadDashScope: 0 };
  return {
    calls,
    gatewayStt: (opts) => { calls.gatewayStt.push(opts); return { kind: 'gateway-stt', opts }; },
    gatewayTts: (opts) => { calls.gatewayTts.push(opts); return new FakeTts(opts); },
    openaiFloor: (opts) => { calls.openaiFloor.push(opts); return new FakeTts(opts); },
    loadDashScope: async () => { calls.loadDashScope += 1; return import('../../../dist/plugins/dashscope/index.js'); },
  };
}

test('speech backend selection: dashscope/ models pick DashScope, anything else the gateway; pins win', () => {
  assert.equal(resolveSttBackend('deepgram/nova-3', {}), 'gateway');
  assert.equal(resolveSttBackend(undefined, {}), 'gateway');
  assert.equal(resolveSttBackend('dashscope/paraformer-realtime-v2', {}), 'dashscope_paraformer');
  assert.equal(resolveSttBackend('deepgram/nova-3', { STT_BACKEND: 'dashscope_paraformer' }), 'dashscope_paraformer');
  assert.throws(() => resolveSttBackend('dashscope/paraformer-realtime-v2', { STT_BACKEND: 'gateway' }), WorkerConfigError);
  assert.throws(() => resolveSttBackend('x', { STT_BACKEND: 'whisper' }), WorkerConfigError);
  assert.equal(resolveTtsBackend('cartesia/sonic-3', {}), 'gateway');
  assert.equal(resolveTtsBackend('dashscope/cosyvoice-v2', {}), 'dashscope_cosyvoice');
  assert.equal(resolveTtsBackend('cartesia/sonic-3', { TTS_BACKEND: 'dashscope_cosyvoice' }), 'dashscope_cosyvoice');
  assert.throws(() => resolveTtsBackend('dashscope/cosyvoice-v2', { TTS_BACKEND: 'gateway' }), WorkerConfigError);
});

test('gateway STT is unchanged: pinned language, server-side fallback, nova-3 default; plugin never loaded', async () => {
  const f = speechFactories();
  const built = await buildStt({ model: 'deepgram/nova-3', language: 'zh-TW', fallbackModels: ['deepgram/nova-2', ''] }, 'en', {}, f);
  assert.equal(built.backend, 'gateway');
  assert.deepEqual(f.calls.gatewayStt, [{ model: 'deepgram/nova-3', language: 'zh', fallback: ['deepgram/nova-2'] }]);
  await buildStt(undefined, 'pt-BR', {}, f);
  assert.deepEqual(f.calls.gatewayStt[1], { model: 'deepgram/nova-3', language: 'pt' });
  assert.equal(f.calls.loadDashScope, 0);
  assert.equal(sttLanguage('xx'), 'multi');
});

test('gateway TTS is unchanged: gateway voice + OpenAI floor, floor-only for bare ids, error without either', async () => {
  const f = speechFactories();
  const built = await buildTts({ model: 'cartesia/sonic-3', voiceId: 'v1', languageCode: 'zh' }, 's1', { OPENAI_API_KEY: 'sk' }, f);
  assert.equal(built.backend, 'gateway');
  assert.ok(built.tts instanceof InterviewTtsFallback);
  assert.deepEqual(f.calls.gatewayTts, [{ model: 'cartesia/sonic-3', voice: 'v1', language: 'zh' }]);
  assert.deepEqual(f.calls.openaiFloor, [{ model: 'tts-1', voice: 'nova', apiKey: 'sk' }]);
  await built.tts.close();

  const floorOnly = await buildTts({ model: 'tts-1', voiceId: 'onyx' }, 's1', { OPENAI_API_KEY: 'sk' }, f);
  assert.equal(floorOnly.voice, 'onyx');
  await floorOnly.tts.close();
  await assert.rejects(buildTts({ model: 'tts-1' }, 's1', {}, f), /no TTS available/);
  assert.equal(f.calls.loadDashScope, 0);
});

test('DashScope STT: Paraformer with the bare model id; missing key fails closed without touching the gateway', async () => {
  const f = speechFactories();
  const warnings = [];
  const built = await buildStt(
    { model: 'dashscope/paraformer-realtime-v2', language: 'zh', fallbackModels: ['dashscope/paraformer-realtime-8k-v2'] },
    'zh', { DASHSCOPE_API_KEY: 'sk-ds' }, f, (m) => warnings.push(m),
  );
  assert.equal(built.backend, 'dashscope_paraformer');
  assert.equal(built.stt.label, 'dashscope.ParaformerSTT');
  assert.equal(built.stt.model, 'paraformer-realtime-v2');
  assert.equal(built.stt.provider, 'dashscope');
  assert.equal(built.stt.options.apiKey, 'sk-ds');
  assert.match(warnings[0], /ignoring fallback models/);
  assert.equal(f.calls.loadDashScope, 1);

  const f2 = speechFactories();
  await assert.rejects(
    buildStt({ model: 'dashscope/paraformer-realtime-v2' }, 'zh', {}, f2),
    (err) => isWorkerConfigError(err) && /DASHSCOPE_API_KEY is not set/.test(err.message),
  );
  assert.equal(f2.calls.gatewayStt.length, 0);
  assert.equal(f2.calls.loadDashScope, 0); // key absent → plugin never loaded

  // A pinned GoApply worker never sends an international model to the gateway.
  const pinned = await buildStt({ model: 'deepgram/nova-3' }, 'zh', { STT_BACKEND: 'dashscope_paraformer', DASHSCOPE_API_KEY: 'k' }, f2);
  assert.equal(pinned.model, 'paraformer-realtime-v2');
  assert.equal(f2.calls.gatewayStt.length, 0);

  await assert.rejects(
    buildStt({ model: 'dashscope/paraformer-realtime-v2' }, 'zh', { DASHSCOPE_API_KEY: 'k', DASHSCOPE_WS_URL: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/' }, f2),
    /not a mainland endpoint/,
  );
});

test('DashScope TTS: CosyVoice voice from metadata, else env, else model default by gender; never an OpenAI floor', async () => {
  const f = speechFactories();
  const env = { DASHSCOPE_API_KEY: 'k', OPENAI_API_KEY: 'sk-openai' };
  const explicit = await buildTts({ model: 'dashscope/cosyvoice-v2', voiceId: 'longwan_v2', label: '普通话 · 女声' }, 's', env, f);
  assert.equal(explicit.backend, 'dashscope_cosyvoice');
  assert.equal(explicit.voice, 'longwan_v2');
  assert.ok(explicit.tts instanceof InterviewTtsFallback);
  assert.equal(explicit.tts.ttsInstances.length, 1);
  assert.equal(explicit.tts.ttsInstances[0].label, 'dashscope.CosyVoiceTTS');
  assert.equal(f.calls.openaiFloor.length, 0);
  assert.equal(f.calls.gatewayTts.length, 0);
  await explicit.tts.close();

  const male = await buildTts({ model: 'dashscope/cosyvoice-v2', voiceId: '', label: '普通话 · 男声' }, 's', env, f);
  assert.equal(male.voice, 'longcheng_v2');
  await male.tts.close();
  const female = await buildTts({ model: 'dashscope/cosyvoice-v2', voiceId: '', label: '國語 · 女聲' }, 's', env, f);
  assert.equal(female.voice, 'longxiaochun_v2');
  await female.tts.close();
  const fromEnv = await buildTts({ model: 'dashscope/cosyvoice-v2', label: 'zh · male' }, 's', { ...env, COSYVOICE_VOICE_ZH_MALE: 'longshu_v2' }, f);
  assert.equal(fromEnv.voice, 'longshu_v2');
  await fromEnv.tts.close();

  await assert.rejects(
    buildTts({ model: 'dashscope/cosyvoice-v3-plus' }, 's', env, f),
    (err) => isWorkerConfigError(err) && /no CosyVoice voice for cosyvoice-v3-plus/.test(err.message),
  );
  await assert.rejects(buildTts({ model: 'dashscope/cosyvoice-v2' }, 's', { OPENAI_API_KEY: 'sk' }, f), /DASHSCOPE_API_KEY is not set/);
  assert.equal(f.calls.openaiFloor.length, 0);
});

test('deployment checks report misconfiguration once at boot; describeBackends never prints secrets', () => {
  assert.deepEqual(backendConfigProblems({}), []);
  const goapplyEnv = {
    INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Interview',
    LLM_BACKEND: 'openai_compatible',
    STT_BACKEND: 'dashscope_paraformer',
    TTS_BACKEND: 'dashscope_cosyvoice',
    DASHSCOPE_API_KEY: 'k',
  };
  assert.deepEqual(backendConfigProblems(goapplyEnv), []);
  const problems = backendConfigProblems({
    LLM_BACKEND: 'openai_compatible',
    LLM_BASE_URL: 'https://api.openai.com/v1',
    STT_BACKEND: 'dashscope_paraformer',
    TTS_BACKEND: 'elevenlabs',
    DASHSCOPE_WS_URL: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/',
  });
  assert.equal(problems.length, 6);
  assert.match(problems.join('\n'), /TTS_BACKEND="elevenlabs"/);
  assert.match(problems.join('\n'), /DASHSCOPE_API_KEY is not set/);
  assert.match(problems.join('\n'), /LLM_BASE_URL host api.openai.com/);
  assert.match(problems.join('\n'), /LLM_BASE_URL is set but LLM_API_KEY is not/);
  assert.match(problems.join('\n'), /not registered as GoApply-Interview/);
  assert.equal(backendConfigProblems({ LLM_BACKEND: 'nope' }).length, 1);

  const line = describeBackends({ LLM_BACKEND: 'openai_compatible', DASHSCOPE_API_KEY: 'sk-secret', LLM_API_KEY: 'sk-2' });
  assert.equal(line, 'llm_backend=openai_compatible stt_backend=auto tts_backend=auto dashscope_key=set brand=roboapply');
  assert.doesNotMatch(line, /sk-/);
  assert.equal(
    describeBackends({ INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Interview' }),
    'llm_backend=openai_compatible stt_backend=auto tts_backend=auto dashscope_key=unset brand=goapply',
  );
});

// ── Brand guard (review finding: GoApply must not fail open to the gateway) ──

const GOAPPLY = { INTERVIEW_ENGINE_AGENT_NAME: 'GoApply-Interview' };

test('a GoApply worker is recognised by its agent name or WORKER_BRAND', () => {
  assert.equal(isGoApplyWorker(GOAPPLY), true);
  assert.equal(isGoApplyWorker({ INTERVIEW_ENGINE_AGENT_NAME: ' goapply-interview ' }), true);
  assert.equal(isGoApplyWorker({ WORKER_BRAND: 'GoApply' }), true);
  assert.equal(isGoApplyWorker({}), false);
  assert.equal(isGoApplyWorker({ INTERVIEW_ENGINE_AGENT_NAME: 'RoboApply-Interview' }), false);
});

test('GoApply LLM: unset LLM_BACKEND means openai_compatible, gateway is refused, the gateway client is never built', () => {
  assert.equal(resolveLlmBackend(GOAPPLY), 'openai_compatible');
  assert.equal(resolveLlmBackend({ WORKER_BRAND: 'goapply' }), 'openai_compatible');
  assert.throws(
    () => resolveLlmBackend({ ...GOAPPLY, LLM_BACKEND: 'gateway' }),
    (err) => isWorkerConfigError(err) && /not allowed on the GoApply worker/.test(err.message),
  );

  // The dev-supervisor case: only the agent name is set, no backend pins.
  const f = llmFactories();
  const built = buildLlm({ llm: { model: 'deepseek/deepseek-chat' } }, { ...GOAPPLY, DEEPSEEK_API_KEY: 'k' }, f);
  assert.equal(built.backend, 'openai_compatible');
  assert.equal(f.calls.gateway.length, 0);

  const f2 = llmFactories();
  assert.throws(() => buildLlm({ llm: { model: 'deepseek/deepseek-chat' } }, { ...GOAPPLY, LLM_BACKEND: 'gateway' }, f2), WorkerConfigError);
  assert.equal(f2.calls.gateway.length, 0);
  // Without a key the domestic route fails closed rather than reaching the gateway.
  assert.throws(() => buildLlm({ llm: { model: 'deepseek/deepseek-chat' } }, GOAPPLY, f2), /no API key/);
  assert.equal(f2.calls.gateway.length, 0);
});

test('GoApply speech: any gateway resolution is refused (explicit pin, international model, or no model)', async () => {
  assert.throws(() => resolveSttBackend('dashscope/paraformer-realtime-v2', { ...GOAPPLY, STT_BACKEND: 'gateway' }), WorkerConfigError);
  assert.throws(() => resolveSttBackend('deepgram/nova-3', GOAPPLY), /only runs DashScope speech/);
  assert.throws(() => resolveSttBackend(undefined, GOAPPLY), /STT_BACKEND=dashscope_paraformer/);
  assert.equal(resolveSttBackend('dashscope/paraformer-realtime-v2', GOAPPLY), 'dashscope_paraformer');
  assert.equal(resolveSttBackend('deepgram/nova-3', { ...GOAPPLY, STT_BACKEND: 'dashscope_paraformer' }), 'dashscope_paraformer');

  assert.throws(() => resolveTtsBackend('cartesia/sonic-3', { WORKER_BRAND: 'goapply' }), /TTS_BACKEND=dashscope_cosyvoice/);
  assert.throws(() => resolveTtsBackend('tts-1', { ...GOAPPLY, TTS_BACKEND: 'gateway' }), WorkerConfigError);
  assert.equal(resolveTtsBackend('dashscope/cosyvoice-v2', GOAPPLY), 'dashscope_cosyvoice');

  const f = speechFactories();
  await assert.rejects(buildStt({ model: 'deepgram/nova-3' }, 'zh', { ...GOAPPLY, DASHSCOPE_API_KEY: 'k' }, f), WorkerConfigError);
  await assert.rejects(buildTts({ model: 'cartesia/sonic-3' }, 's', { ...GOAPPLY, OPENAI_API_KEY: 'sk' }, f), WorkerConfigError);
  assert.equal(f.calls.gatewayStt.length, 0);
  assert.equal(f.calls.gatewayTts.length, 0);
  assert.equal(f.calls.openaiFloor.length, 0);
});

test('GoApply boot checks flag unpinned speech, a gateway LLM and a missing DashScope key', () => {
  const problems = backendConfigProblems(GOAPPLY).join('\n');
  assert.match(problems, /STT_BACKEND is unset; pin STT_BACKEND=dashscope_paraformer/);
  assert.match(problems, /TTS_BACKEND is unset; pin TTS_BACKEND=dashscope_cosyvoice/);
  assert.match(problems, /GoApply worker: DASHSCOPE_API_KEY is not set/);
  assert.match(backendConfigProblems({ ...GOAPPLY, LLM_BACKEND: 'gateway' }).join('\n'), /not allowed on the GoApply worker/);
  assert.match(backendConfigProblems({ WORKER_BRAND: 'goapply', STT_BACKEND: 'gateway' }).join('\n'), /STT_BACKEND is "gateway"/);
});

test('LLM_BASE_URL needs its own LLM_API_KEY: a vendor key is only sent to that vendor', () => {
  const gw = { LLM_BASE_URL: 'https://llm.goapply.internal.cn/v1', DOMESTIC_HOSTS: 'llm.goapply.internal.cn', DEEPSEEK_API_KEY: 'sk-ds' };
  assert.throws(
    () => resolveOpenAiCompatibleRoute({ llm: { model: 'deepseek/deepseek-chat' } }, gw),
    (err) => isWorkerConfigError(err) && /LLM_BASE_URL is set but LLM_API_KEY is not/.test(err.message),
  );
  const ok = resolveOpenAiCompatibleRoute({ llm: { model: 'deepseek/deepseek-chat' } }, { ...gw, LLM_API_KEY: 'sk-gw' });
  assert.equal(ok.apiKey, 'sk-gw');
  // The vendor's own endpoint override still uses the vendor key.
  const own = resolveOpenAiCompatibleRoute(
    { llm: { model: 'deepseek/deepseek-chat' } },
    { DEEPSEEK_API_BASE_URL: 'https://api.deepseek.com/beta', DEEPSEEK_API_KEY: 'sk-ds' },
  );
  assert.equal(own.apiKey, 'sk-ds');
});

// ── Barge-in gate (review finding: unspaced CJK transcripts count as 1 word) ─

test('interruption: minWords 1 for Paraformer and zh/ja/ko sessions, 2 otherwise; minDuration stays 600 ms', () => {
  // The SDK's word count is a whitespace split: a whole Chinese sentence is one word.
  assert.equal(tokenize.basic.splitWords('你好，我叫李明。').length, 1);
  assert.equal(tokenize.basic.splitWords('等一下，我想补充一点').length, 1);

  assert.deepEqual(interruptionFor('gateway', 'en'), { enabled: true, minDuration: 600, minWords: 2 });
  assert.equal(interruptionFor('gateway', 'pt-BR').minWords, 2);
  assert.equal(interruptionFor('gateway', undefined).minWords, 2);
  assert.deepEqual(interruptionFor('dashscope_paraformer', 'zh'), { enabled: true, minDuration: 600, minWords: 1 });
  assert.equal(interruptionFor('dashscope_paraformer', 'en').minWords, 1);
  assert.equal(interruptionFor('gateway', 'zh-TW').minWords, 1);
  assert.equal(interruptionFor('gateway', 'ja').minWords, 1);
  assert.equal(interruptionFor('gateway', 'ko-KR').minWords, 1);
});

// ── Session build + worker_config report (review finding: untested path) ────

class ClosingTts extends FakeTts {
  constructor(opts, closed) { super(opts); this.closedLog = closed; }
  async close() { this.closedLog.push('tts'); }
}

function sessionDeps(env, overrides = {}) {
  const posts = [];
  const closed = [];
  const warnings = [];
  const errors = [];
  const sf = speechFactories();
  const speech = {
    ...sf,
    gatewayStt: (opts) => ({ kind: 'gateway-stt', opts, close: async () => { closed.push('stt'); } }),
    gatewayTts: (opts) => new ClosingTts(opts, closed),
    openaiFloor: (opts) => new ClosingTts(opts, closed),
  };
  return {
    posts, closed, warnings, errors,
    deps: {
      sessionId: 'sess-1',
      env,
      speechFactories: speech,
      llmFactories: llmFactories(),
      post: async (path, body) => { posts.push({ path, body }); return 'ok'; },
      warn: (m) => warnings.push(m),
      error: (m) => errors.push(m),
      ...overrides,
    },
  };
}

test('buildSessionModels returns the three built models on success and posts nothing', async () => {
  const h = sessionDeps({ OPENAI_API_KEY: 'sk' });
  const models = await buildSessionModels(
    { llm: { model: 'openai/gpt-5.4-mini' }, stt: { model: 'deepgram/nova-3' }, voice: { model: 'cartesia/sonic-3' }, language: 'en' },
    h.deps,
  );
  assert.equal(models.llm.backend, 'gateway');
  assert.equal(models.stt.backend, 'gateway');
  assert.equal(models.tts.backend, 'gateway');
  assert.deepEqual(h.posts, []);
  await models.tts.tts.close();
});

test('buildSessionModels: a WorkerConfigError posts lifecycle worker_config, closes what was built, and rethrows', async () => {
  // TTS + STT build fine; the LLM has no vendor key → WorkerConfigError.
  const h = sessionDeps({ LLM_BACKEND: 'openai_compatible', OPENAI_API_KEY: 'sk' });
  await assert.rejects(
    buildSessionModels(
      { llm: { model: 'deepseek/deepseek-chat' }, stt: { model: 'deepgram/nova-3' }, voice: { model: 'cartesia/sonic-3' } },
      h.deps,
    ),
    WorkerConfigError,
  );
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].path, lifecyclePath('sess-1'));
  assert.equal(h.posts[0].path, '/api/v1/interview-engine/callbacks/sessions/sess-1/lifecycle');
  assert.equal(h.posts[0].body.event, 'error');
  assert.equal(h.posts[0].body.reason, 'worker_config');
  assert.match(h.posts[0].body.message, /no API key for model "deepseek\/deepseek-chat"/);
  assert.match(h.errors[0], /worker configuration error/);
  // Both the TTS (primary + floor) and the STT were closed.
  assert.ok(h.closed.includes('tts'));
  assert.ok(h.closed.includes('stt'));
});

test('buildSessionModels: a plain Error is rethrown without a worker_config report', async () => {
  const h = sessionDeps({}); // gateway voice with a bare id and no OPENAI_API_KEY → plain Error
  await assert.rejects(buildSessionModels({ llm: { model: 'a/b' }, voice: { model: 'tts-1' } }, h.deps), /no TTS available/);
  assert.equal(h.posts.length, 0);
});

test('buildSessionModels: a failing report is logged and the original error still surfaces', async () => {
  const h = sessionDeps({}, { post: async () => { throw new Error('callback down'); } });
  await assert.rejects(
    buildSessionModels({ voice: { model: 'dashscope/cosyvoice-v2' } }, h.deps),
    (err) => isWorkerConfigError(err) && /DASHSCOPE_API_KEY is not set/.test(err.message),
  );
  assert.match(h.warnings.join('\n'), /worker_config report failed: callback down/);
});
