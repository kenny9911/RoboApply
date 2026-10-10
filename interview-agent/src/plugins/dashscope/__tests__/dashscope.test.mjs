// WP-63b DashScope plugins against websocket fixtures
// (src/plugins/dashscope/fixtures/*.json, replayed by replay.ts — no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { APIStatusError, initializeLogger, stt, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import {
  CosyVoiceTTS,
  DASHSCOPE_WS_URL,
  DuplexTask,
  ParaformerSTT,
  paraformerLanguageHints,
  paraformerParameters,
  resolveCosyVoice,
  taskFailedError,
  voiceGenderFromLabel,
} from '../../../../dist/plugins/dashscope/index.js';
import { recordingFactory, replayFactory } from '../../../../dist/plugins/dashscope/replay.js';
import { InterviewTtsFallback } from '../../../../dist/tts-fallback.js';

initializeLogger({ pretty: false, level: 'silent' });

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf-8'));

const NO_RETRY = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 5000 };

function pcmFrame(samples = 1600, rate = 16000) {
  return new AudioFrame(new Int16Array(samples), rate, 1, samples);
}

async function collect(stream, { until } = {}) {
  const events = [];
  for await (const ev of stream) {
    events.push(ev);
    if (until?.(ev)) break;
  }
  return events;
}

/** Feed 100 ms frames until the fixture waits for finish-task (or is done), then end input. */
async function feedUntilExhausted(stream, socketOf, maxFrames = 200) {
  for (let i = 0; i < maxFrames; i += 1) {
    const socket = socketOf();
    if (socket && (socket.exhausted || isWaitingForFinish(socket))) break;
    try { stream.pushFrame(pcmFrame()); } catch { break; }
    await new Promise((r) => setTimeout(r, 1));
  }
  try { stream.endInput(); } catch { /* already closed */ }
}

function isWaitingForFinish(socket) {
  return socket.fixture.frames[socket.cursor]?.action === 'finish-task';
}

// ── Paraformer STT ───────────────────────────────────────────────────────────

test('Paraformer: run-task envelope, bearer auth, interim → final transcripts, usage, heartbeat ignored', async () => {
  const factory = replayFactory(fixture('paraformer-zh-interim-final'));
  const engine = new ParaformerSTT({ apiKey: 'sk-test', model: 'paraformer-realtime-v2', language: 'zh-CN', socketFactory: factory });
  assert.equal(engine.capabilities.streaming, true);
  assert.equal(engine.capabilities.interimResults, true);
  const stream = engine.stream({ connOptions: NO_RETRY });
  const eventsP = collect(stream);
  await feedUntilExhausted(stream, () => factory.sockets[0]);
  const events = await eventsP;

  const socket = factory.sockets[0];
  assert.equal(factory.sockets.length, 1);
  assert.equal(socket.url, DASHSCOPE_WS_URL);
  assert.equal(socket.headers.Authorization, 'bearer sk-test');
  assert.deepEqual(socket.violations, []);
  assert.ok(socket.exhausted, 'every fixture frame consumed');

  const runTask = socket.sent[0].body;
  assert.equal(runTask.header.action, 'run-task');
  assert.equal(runTask.header.streaming, 'duplex');
  assert.match(runTask.header.task_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(runTask.payload, {
    task_group: 'audio',
    task: 'asr',
    function: 'recognition',
    model: 'paraformer-realtime-v2',
    parameters: {
      format: 'pcm', sample_rate: 16000, disfluency_removal_enabled: false, heartbeat: true,
      max_sentence_silence: 500, language_hints: ['zh', 'en'],
    },
    input: {},
  });
  // Audio goes up as raw 16-bit PCM (3200 bytes per 100 ms frame at 16 kHz).
  assert.ok(socket.sent.filter((m) => m.type === 'binary').every((m) => m.bytes === 3200));
  const last = socket.sent.filter((m) => m.type === 'json').at(-1).body;
  assert.equal(last.header.action, 'finish-task');
  assert.equal(last.header.task_id, runTask.header.task_id);
  assert.ok(socket.closedByClient);

  const T = stt.SpeechEventType;
  const shape = events.map((e) => [e.type, e.alternatives?.[0]?.text ?? null]);
  assert.deepEqual(shape, [
    [T.START_OF_SPEECH, null],
    [T.INTERIM_TRANSCRIPT, '你好'],
    [T.INTERIM_TRANSCRIPT, '你好，我叫李明'],
    [T.FINAL_TRANSCRIPT, '你好，我叫李明。'],
    [T.END_OF_SPEECH, '你好，我叫李明。'],
    [T.RECOGNITION_USAGE, null],
  ]);
  const final = events[3].alternatives[0];
  assert.equal(final.language, 'zh');
  assert.equal(final.startTime >= 0.17, true);
  assert.equal(final.endTime >= 1.45, true);
  assert.equal(events[5].recognitionUsage.audioDuration, 2);
  assert.ok(events.every((e) => e.requestId === runTask.header.task_id));
  await engine.close();
});

test('Paraformer: a final task failure (bad key) ends the stream with a non-retryable error event', async () => {
  const factory = replayFactory(fixture('paraformer-invalid-key'));
  const engine = new ParaformerSTT({ apiKey: 'sk-bad', socketFactory: factory });
  const errors = [];
  engine.on('error', (e) => errors.push(e));
  const stream = engine.stream({ connOptions: { ...NO_RETRY, maxRetry: 3 } });
  const events = await collect(stream);
  assert.deepEqual(events, []);
  assert.equal(factory.sockets.length, 1, 'InvalidApiKey is never retried');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].recoverable, false);
  assert.ok(errors[0].error instanceof APIStatusError);
  assert.equal(errors[0].error.retryable, false);
  assert.match(errors[0].error.message, /InvalidApiKey: Invalid API-key provided\./);
});

test('Paraformer: an idle timeout is retried on a fresh task and recognition continues', async () => {
  const factory = replayFactory(fixture('paraformer-idle-timeout'), fixture('paraformer-zh-interim-final'));
  const engine = new ParaformerSTT({ apiKey: 'sk', socketFactory: factory });
  const stream = engine.stream({ connOptions: { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 5000 } });
  const eventsP = collect(stream);
  await feedUntilExhausted(stream, () => (factory.sockets.length >= 2 ? factory.sockets[1] : null));
  const events = await eventsP;
  assert.equal(factory.sockets.length, 2);
  assert.ok(factory.sockets[0].closedByClient);
  assert.ok(events.some((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT && e.alternatives[0].text === '你好，我叫李明。'));
  await engine.close();
});

test('Paraformer: closing the stream closes the socket without an error event', async () => {
  const factory = replayFactory(fixture('paraformer-zh-interim-final'));
  const engine = new ParaformerSTT({ apiKey: 'sk', socketFactory: factory });
  const errors = [];
  engine.on('error', (e) => errors.push(e));
  const stream = engine.stream({ connOptions: NO_RETRY });
  stream.pushFrame(pcmFrame());
  await new Promise((r) => setTimeout(r, 20));
  stream.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(factory.sockets[0].closedByClient);
  assert.deepEqual(errors, []);
});

// ── CosyVoice TTS ────────────────────────────────────────────────────────────

test('CosyVoice stream: text streams as continue-task, FLUSH finishes the task, PCM becomes 100 ms frames', async () => {
  const fx = fixture('cosyvoice-zh-stream');
  const factory = replayFactory(fx);
  const engine = new CosyVoiceTTS({ apiKey: 'sk-tts', model: 'cosyvoice-v2', voice: 'longxiaochun_v2', socketFactory: factory });
  assert.equal(engine.sampleRate, 24000);
  assert.equal(engine.capabilities.streaming, true);
  const stream = engine.stream({ connOptions: NO_RETRY });
  stream.pushText('你好，我是今天的面试官。');
  stream.pushText('请先做个自我介绍。');
  stream.flush();
  stream.endInput();

  const out = [];
  for await (const ev of stream) {
    out.push(ev);
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
  }
  const socket = factory.sockets[0];
  assert.deepEqual(socket.violations, []);
  assert.ok(socket.exhausted);
  const json = socket.sent.filter((m) => m.type === 'json').map((m) => m.body);
  assert.deepEqual(json.map((b) => b.header.action), ['run-task', 'continue-task', 'continue-task', 'finish-task']);
  assert.deepEqual(json[0].payload, {
    task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: 'cosyvoice-v2',
    parameters: { text_type: 'PlainText', voice: 'longxiaochun_v2', format: 'pcm', sample_rate: 24000, volume: 50, rate: 1, pitch: 1 },
    input: {},
  });
  assert.deepEqual(json.slice(1, 3).map((b) => b.payload.input.text), ['你好，我是今天的面试官。', '请先做个自我介绍。']);
  assert.ok(json.every((b) => b.header.task_id === json[0].header.task_id));

  assert.equal(out.at(-1), tts.SynthesizeStream.END_OF_STREAM);
  const audio = out.slice(0, -1);
  // 2400 + 1500 + 900 samples = 4800 → two 100 ms frames, the last one final.
  assert.deepEqual(audio.map((a) => [a.frame.samplesPerChannel, a.frame.sampleRate, a.final]), [[2400, 24000, false], [2400, 24000, true]]);
  assert.ok(audio.every((a) => a.segmentId === json[0].header.task_id));
  // Bytes pass through untouched (the fixture is a 440 Hz tone).
  const expected = Buffer.concat(fx.frames.filter((f) => f.base64).map((f) => Buffer.from(f.base64, 'base64')));
  const got = Buffer.concat(audio.map((a) => Buffer.from(a.frame.data.buffer, a.frame.data.byteOffset, a.frame.data.byteLength)));
  assert.equal(Buffer.compare(got, expected), 0);
  await engine.close();
});

test('CosyVoice inside the session TTS wrapper (InterviewTtsFallback) streams a whole turn', async () => {
  const factory = replayFactory(fixture('cosyvoice-zh-stream'));
  const wrapper = new InterviewTtsFallback([
    new CosyVoiceTTS({ apiKey: 'sk', voice: 'longxiaochun_v2', socketFactory: factory }),
  ]);
  const stream = wrapper.stream();
  stream.pushText('请先做个自我介绍。');
  stream.flush();
  stream.endInput();
  const frames = [];
  for await (const ev of stream) {
    if (ev === tts.SynthesizeStream.END_OF_STREAM) break;
    frames.push(ev);
  }
  assert.equal(frames.reduce((n, f) => n + f.frame.samplesPerChannel, 0), 4800);
  assert.deepEqual(factory.sockets[0].violations, []);
  await wrapper.close();
});

test('CosyVoice synthesize(): one-shot text through the same task (used by SDK adapters)', async () => {
  const factory = replayFactory(fixture('cosyvoice-zh-stream'));
  const engine = new CosyVoiceTTS({ apiKey: 'sk', voice: 'longcheng_v2', socketFactory: factory });
  const frames = [];
  for await (const ev of engine.synthesize('请先做个自我介绍。', NO_RETRY)) frames.push(ev);
  assert.deepEqual(frames.map((f) => f.final), [false, true]);
  const json = factory.sockets[0].sent.filter((m) => m.type === 'json').map((m) => m.body);
  assert.deepEqual(json.map((b) => b.header.action), ['run-task', 'continue-task', 'finish-task']);
  assert.equal(json[0].payload.parameters.voice, 'longcheng_v2');
  assert.equal(json[0].payload.model, 'cosyvoice-v2');
});

test('CosyVoice: a rejected voice is a final error (no retry storm)', async () => {
  const factory = replayFactory(fixture('cosyvoice-invalid-voice'));
  const engine = new CosyVoiceTTS({ apiKey: 'sk', voice: 'nope', socketFactory: factory });
  const errors = [];
  engine.on('error', (e) => errors.push(e));
  const stream = engine.stream({ connOptions: { maxRetry: 3, retryIntervalMs: 0, timeoutMs: 5000 } });
  stream.pushText('你好');
  stream.flush();
  stream.endInput();
  const out = [];
  for await (const ev of stream) out.push(ev);
  assert.deepEqual(out, []);
  assert.equal(factory.sockets.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.retryable, false);
  assert.match(errors[0].error.message, /InvalidParameter: voice not found/);
});

// ── Protocol + model helpers ─────────────────────────────────────────────────

test('task-failed classification: throttling/timeouts retry, credentials/parameters do not', () => {
  const cls = (error_code, error_message = '') => taskFailedError({ error_code, error_message }, 't').retryable;
  assert.equal(cls('Throttling.RateQuota'), true);
  assert.equal(cls('InternalError'), true);
  assert.equal(cls('CLIENT_ERROR', 'request timeout after 23 seconds.'), true);
  assert.equal(cls('CLIENT_ERROR', 'invalid payload'), false);
  assert.equal(cls('InvalidApiKey'), false);
  assert.equal(cls('Arrearage'), false);
  assert.equal(cls('DataInspectionFailed'), false);
  assert.equal(cls('ModelNotFound'), false);
});

test('a socket that never reports task-started times out; a missing key never dials', async () => {
  const silent = { frames: [{ dir: 'client', action: 'run-task' }], name: 'silent', kind: 'stt', source: 'test', model: 'm' };
  const factory = replayFactory(silent);
  await assert.rejects(
    DuplexTask.start({ apiKey: 'k', socketFactory: factory, connectTimeoutMs: 30 }, { task: 'asr', function: 'recognition', model: 'm', parameters: {} }, {}),
    /did not start within 30ms/,
  );
  assert.ok(factory.sockets[0].closedByClient);
  const never = replayFactory(silent);
  await assert.rejects(
    DuplexTask.start({ apiKey: '', socketFactory: never }, { task: 'asr', function: 'recognition', model: 'm', parameters: {} }, {}),
    /DASHSCOPE_API_KEY is not set/,
  );
  assert.equal(never.sockets.length, 0);
});

test('recordingFactory captures frames with the task id scrubbed and no credentials', async () => {
  const frames = [];
  const factory = recordingFactory(replayFactory(fixture('cosyvoice-zh-stream')), frames);
  const engine = new CosyVoiceTTS({ apiKey: 'sk-secret', voice: 'longxiaochun_v2', socketFactory: factory });
  for await (const _ of engine.synthesize('你好', NO_RETRY)) { /* drain */ }
  const text = JSON.stringify(frames);
  assert.doesNotMatch(text, /sk-secret/);
  assert.deepEqual(frames.filter((f) => f.dir === 'client').map((f) => f.action), ['run-task', 'continue-task', 'finish-task']);
  assert.equal(frames.find((f) => f.json?.header?.event === 'task-started').json.header.task_id, '{{task_id}}');
  assert.equal(frames.filter((f) => f.base64).length, 3);
});

test('model helpers: language hints, 8k rate, voice gender from the control-plane label', () => {
  assert.deepEqual(paraformerLanguageHints('paraformer-realtime-v2', 'zh-TW'), ['zh', 'en']);
  assert.deepEqual(paraformerLanguageHints('paraformer-realtime-v2', 'ja'), ['ja']);
  assert.equal(paraformerLanguageHints('paraformer-realtime-v2', 'multi'), undefined);
  assert.equal(paraformerLanguageHints('paraformer-realtime-v1', 'zh'), undefined);
  assert.deepEqual(paraformerParameters('paraformer-realtime-v1', 'zh'), { format: 'pcm', sample_rate: 16000, disfluency_removal_enabled: false, heartbeat: true });
  assert.equal(paraformerParameters('paraformer-realtime-8k-v2', 'zh').sample_rate, 8000);
  assert.equal(voiceGenderFromLabel('普通话 · 男声'), 'male');
  assert.equal(voiceGenderFromLabel('國語 · 女聲'), 'female');
  assert.equal(voiceGenderFromLabel('zh · female'), 'female');
  assert.equal(voiceGenderFromLabel('zh · male'), 'male');
  assert.equal(voiceGenderFromLabel(undefined), 'female');
  assert.equal(resolveCosyVoice('cosyvoice-v1', '', 'male', {}), 'longcheng');
  assert.equal(resolveCosyVoice('cosyvoice-v2', ' custom ', 'male', {}), 'custom');
  assert.equal(resolveCosyVoice('cosyvoice-v3-flash', '', 'female', {}), null);
  assert.equal(resolveCosyVoice('cosyvoice-v3-flash', '', 'female', { COSYVOICE_VOICE_ZH_FEMALE: 'v3voice' }), 'v3voice');
});

test('record-fixture: usageTrace lists usage.duration per final sentence (owner checks per-sentence vs cumulative)', async () => {
  const { usageTrace } = await import('../../../../dist/plugins/dashscope/record-fixture.js');
  const trace = usageTrace(fixture('paraformer-zh-interim-final').frames);
  assert.ok(trace.length >= 1);
  for (const row of trace) {
    assert.ok(row.endTimeMs === null || typeof row.endTimeMs === 'number');
    assert.ok(row.duration === null || typeof row.duration === 'number');
  }
  assert.deepEqual(usageTrace([{ dir: 'client', action: 'run-task' }, { dir: 'server', base64: '' }]), []);
});
