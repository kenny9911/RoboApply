import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIError, initializeLogger, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { InterviewTtsFallback } from '../dist/tts-fallback.js';
import { SafeOpenAiTts } from '../dist/safe-openai-tts.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeTts extends tts.TTS {
  streamCalls = 0;
  synthesizeCalls = 0;
  closeCalls = 0;

  constructor(label, { streaming = true, failure } = {}) {
    super(24000, 1, { streaming });
    this.label = label;
    this.failure = failure;
  }

  stream(options) {
    assert.equal(this.capabilities.streaming, true);
    this.streamCalls++;
    this.lastConnOptions = options?.connOptions;
    return new FakeStreaming(this, options?.connOptions);
  }

  synthesize(text, options, signal) {
    this.synthesizeCalls++;
    if (this.capabilities.streaming) throw new Error('ChunkedStream is not implemented');
    return new FakeChunked(this, text, options, signal);
  }

  async close() {
    this.closeCalls++;
  }
}

function frame(provider) {
  return {
    requestId: 'test-request',
    segmentId: provider.label,
    frame: new AudioFrame(new Int16Array(240), provider.sampleRate, 1, 240),
    final: true,
  };
}

class FakeStreaming extends tts.SynthesizeStream {
  label = 'fake.Streaming';

  constructor(provider, options) {
    super(provider, options);
    this.provider = provider;
  }

  async run() {
    if (this.provider.failure) throw this.provider.failure;
    for await (const token of this.input) {
      if (token !== tts.SynthesizeStream.FLUSH_SENTINEL) {
        this.markStarted();
        this.queue.put(frame(this.provider));
      }
    }
  }
}

class FakeChunked extends tts.ChunkedStream {
  label = 'fake.Chunked';

  constructor(provider, text, options, signal) {
    super(text, provider, options, signal);
    this.provider = provider;
  }

  async run() {
    if (this.provider.failure) throw this.provider.failure;
    this.queue.put(frame(this.provider));
  }
}

async function speak(adapter, options) {
  const stream = adapter.stream(options);
  stream.updateInputStream(new ReadableStream({
    start(controller) {
      controller.enqueue('Hello world.');
      controller.close();
    },
  }));
  const output = [];
  try {
    for await (const audio of stream) {
      if (audio !== tts.SynthesizeStream.END_OF_STREAM) output.push(audio);
    }
  } finally {
    stream.close();
  }
  return output;
}

test('failed inference streams use the chunked backup without health probes or fatal child errors', { timeout: 5000 }, async () => {
  const primary = new FakeTts('inference.TTS', { failure: new APIError('gateway unavailable') });
  const backup = new FakeTts('openai.TTS', { streaming: false });
  const adapter = new InterviewTtsFallback([primary, backup]);
  const errors = [];
  adapter.on('error', (error) => errors.push(error));
  try {
    for (let turn = 0; turn < 3; turn++) {
      const audio = await speak(adapter);
      assert.ok(audio.length > 0);
      assert.equal(audio[0].segmentId, 'openai.TTS');
      assert.equal(backup.listenerCount('error'), 1, 'one owned StreamAdapter across turns');
    }
    assert.equal(primary.streamCalls, 1);
    assert.equal(primary.synthesizeCalls, 0, 'inference synthesize() must never be used for recovery');
    assert.equal(backup.synthesizeCalls, 3);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((error) => error.recoverable));
    assert.ok(adapter.status.every((status) => status.recoveringTask === null));
  } finally {
    await adapter.close();
  }
});

test('quota exhaustion emits one aggregate failure and does not request the exhausted account again', { timeout: 5000 }, async () => {
  const primary = new FakeTts('inference.TTS', { failure: new APIError('gateway unavailable') });
  const quotaError = Object.assign(new Error('No credits remaining'), { code: 'credit_balance_exhausted' });
  let requests = 0;
  const backup = new SafeOpenAiTts({ client: {
    audio: { speech: { create() { requests++; return Promise.reject(quotaError); } } },
  } });
  const adapter = new InterviewTtsFallback([primary, backup]);
  const errors = [];
  adapter.on('error', (error) => errors.push(error));
  try {
    assert.equal((await speak(adapter)).length, 0);
    assert.equal((await speak(adapter)).length, 0);
    assert.equal(requests, 1, 'permanent quota failures must not retry requests');
    const fatalErrors = errors.filter((error) => !error.recoverable);
    assert.equal(fatalErrors.length, 2, 'only the exhausted chain is fatal, once per utterance');
    assert.ok(fatalErrors.every((error) => error.label === adapter.label));
    assert.ok(errors.every((event) => event.error.code !== 'ERR_UNHANDLED_ERROR'));
    assert.ok(adapter.status.every((status) => status.recoveringTask === null));
  } finally {
    await adapter.close();
  }
});

test('session connection options cannot retry the exhausted provider chain', { timeout: 5000 }, async () => {
  const primary = new FakeTts('primary.TTS', { failure: new APIError('primary unavailable') });
  const backup = new FakeTts('backup.TTS', { failure: new APIError('backup unavailable') });
  const adapter = new InterviewTtsFallback([primary, backup]);
  const errors = [];
  adapter.on('error', (error) => errors.push(error));
  try {
    const audio = await speak(adapter, {
      connOptions: { maxRetry: 3, timeoutMs: 12345, retryIntervalMs: 0 },
    });
    assert.equal(audio.length, 0);
    assert.equal(primary.streamCalls, 1, 'the primary is attempted once per utterance');
    assert.equal(backup.streamCalls, 1, 'the backup is attempted once per utterance');
    assert.equal(primary.lastConnOptions.timeoutMs, 12345);
    assert.equal(backup.lastConnOptions.timeoutMs, 12345);
    const fatalErrors = errors.filter((error) => !error.recoverable);
    assert.equal(fatalErrors.length, 1);
    assert.equal(fatalErrors[0].label, adapter.label);
  } finally {
    await adapter.close();
  }
});

test('safe OpenAI floor preserves PCM synthesis and voice settings', { timeout: 5000 }, async () => {
  const requests = [];
  const floor = new SafeOpenAiTts({ voice: 'nova', client: {
    audio: { speech: { create(body) {
      requests.push(body);
      return Promise.resolve(new Response(new Uint8Array(4800)));
    } } },
  } });
  const adapter = new InterviewTtsFallback([floor]);
  const errors = [];
  adapter.on('error', (error) => errors.push(error));
  try {
    const audio = await speak(adapter);
    assert.ok(audio.length > 0);
    assert.equal(audio[0].frame.sampleRate, 24000);
    assert.equal(requests[0].voice, 'nova');
    assert.equal(requests[0].response_format, 'pcm');
    assert.deepEqual(errors, []);
  } finally {
    await adapter.close();
  }
});

test('aborted OpenAI synthesis completes without a provider error', { timeout: 5000 }, async () => {
  let rejectResponse;
  const floor = new SafeOpenAiTts({ client: {
    audio: { speech: { create() {
      return new Promise((_, reject) => { rejectResponse = reject; });
    } } },
  } });
  const errors = [];
  floor.on('error', (error) => errors.push(error));
  const stream = floor.synthesize('Hello world.');
  await floor.close();
  rejectResponse(new Error('Request cancelled'));
  const audio = [];
  for await (const event of stream) audio.push(event);
  assert.deepEqual(audio, []);
  assert.deepEqual(errors, []);
  stream.close();
});

test('an already aborted signal does not report a new provider failure', { timeout: 5000 }, async () => {
  const floor = new SafeOpenAiTts({ client: {
    audio: { speech: { create() { return Promise.reject(new Error('Request cancelled')); } } },
  } });
  const errors = [];
  floor.on('error', (error) => errors.push(error));
  const stream = floor.synthesize('Hello world.', undefined, AbortSignal.abort());
  const audio = [];
  for await (const event of stream) audio.push(event);
  assert.deepEqual(audio, []);
  assert.deepEqual(errors, []);
  stream.close();
  await floor.close();
});

test('close owns providers, is idempotent, and safely drains abort errors', { timeout: 5000 }, async () => {
  const primary = new FakeTts('inference.TTS', { failure: new APIError('gateway unavailable') });
  const backup = new FakeTts('openai.TTS', { streaming: false });
  const adapter = new InterviewTtsFallback([primary, backup]);
  adapter.on('error', () => {});
  await speak(adapter);
  await adapter.close();
  await adapter.close();
  assert.equal(primary.closeCalls, 1);
  assert.equal(backup.closeCalls, 1);
  assert.equal(primary.listenerCount('metrics_collected'), 0);
  assert.equal(backup.listenerCount('metrics_collected'), 0);
  assert.doesNotThrow(() => backup.emit('error', {
    type: 'tts_error', label: backup.label, timestamp: Date.now(),
    error: new Error('request aborted'), recoverable: false,
  }));
  assert.ok(adapter.status.every((status) => status.recoveringTask === null));
});

test('an active fallback settling after session teardown never emits an unhandled error', { timeout: 5000 }, async (t) => {
  const emitterThrows = [];
  const lateErrors = [];
  const streamingEmit = tts.StreamAdapter.prototype.emit;
  t.mock.method(tts.StreamAdapter.prototype, 'emit', function (...args) {
    if (args[0] === 'error') lateErrors.push('stream-adapter');
    try {
      return streamingEmit.apply(this, args);
    } catch (error) {
      emitterThrows.push(error);
      throw error;
    }
  });
  let requests = 0;
  const floor = new SafeOpenAiTts({ client: {
    audio: { speech: { create() { requests += 1; throw new Error('provider is already closed'); } } },
  } });
  const adapter = new InterviewTtsFallback([floor]);
  const outerEmit = adapter.emit;
  t.mock.method(adapter, 'emit', function (...args) {
    if (args[0] === 'error') lateErrors.push('fallback');
    try {
      return outerEmit.apply(this, args);
    } catch (error) {
      emitterThrows.push(error);
      throw error;
    }
  });

  // A pending SDK stream can resume provider failover after AgentSession has
  // detached its error listener and the model's close() has finished.
  adapter.on('error', () => {});
  const stream = adapter.stream();
  adapter.removeAllListeners('error');
  await adapter.close();
  stream.updateInputStream(new ReadableStream({
    start(controller) { controller.enqueue('Hello.'); controller.close(); },
  }));
  try {
    for await (const _ of stream) {}
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    assert.deepEqual(lateErrors, ['stream-adapter', 'fallback']);
    assert.deepEqual(emitterThrows, []);
  } finally {
    stream.close();
    await adapter.close();
  }
});
