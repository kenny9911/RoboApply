import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage, SessionLifecycle } from '../dist/session-lifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(closeTts = async () => {}) {
  const warnings = [];
  const lifecycle = new SessionLifecycle(closeTts, (message) => warnings.push(message));
  return { lifecycle, warnings };
}

test('closing during a settled silent greeting suppresses retry and successful startup', async () => {
  const speech = deferred();
  const { lifecycle } = fixture();
  let attempts = 0;
  let started = false;
  const greeting = lifecycle.greet(async () => { attempts += 1; await speech.promise; });
  await lifecycle.close();
  speech.resolve();
  if (await greeting) started = true;
  assert.equal(attempts, 1);
  assert.equal(started, false);
});

test('closing during a rejected greeting suppresses the LLM fallback', async () => {
  const speech = deferred();
  const { lifecycle } = fixture();
  let fallbacks = 0;
  const greeting = lifecycle.greet(
    async () => { await speech.promise; },
    async () => { fallbacks += 1; },
  );
  await lifecycle.close();
  speech.reject(new Error('provider unavailable'));
  assert.equal(await greeting, false);
  assert.equal(fallbacks, 0);
});

test('silent TTS success settles after one replay without reporting an audible greeting', async () => {
  const { lifecycle } = fixture();
  const attempts = [];
  const audible = await lifecycle.greet(async (repeat) => { attempts.push(repeat); });
  assert.deepEqual(attempts, [false, true]);
  assert.equal(audible, false);
});

test('an audible retry succeeds and marks the repeat so it does not duplicate chat context', async () => {
  const { lifecycle } = fixture();
  const attempts = [];
  const audible = await lifecycle.greet(async (repeat) => {
    attempts.push(repeat);
    if (repeat) lifecycle.recordAudio();
  });
  assert.equal(audible, true);
  assert.deepEqual(attempts, [false, true]);
});

test('an audible first greeting succeeds without a repeat or LLM fallback', async () => {
  const { lifecycle } = fixture();
  let attempts = 0;
  const audible = await lifecycle.greet(
    async () => { attempts += 1; lifecycle.recordAudio(); },
    async () => { assert.fail('unnecessary LLM fallback'); },
  );
  assert.equal(audible, true);
  assert.equal(attempts, 1);
});

test('closure remains a failure even if audio played before the session closed', async () => {
  const { lifecycle } = fixture();
  assert.equal(await lifecycle.greet(async () => {
    lifecycle.recordAudio();
    await lifecycle.close();
  }), false);
});

test('closure cancels startup waits immediately and closes model recovery tasks only once', async () => {
  const cleanup = deferred();
  let closes = 0;
  const { lifecycle } = fixture(async () => { closes += 1; await cleanup.promise; });
  const first = lifecycle.close();
  const second = lifecycle.close();
  assert.equal(lifecycle.active, false);
  assert.equal(await lifecycle.whenClosed, 'closed');
  assert.equal(closes, 1);
  assert.equal(first, second);
  assert.equal(await lifecycle.greet(async () => { assert.fail('greeting after close'); }), false);
  cleanup.resolve();
  await Promise.all([first, second]);
});

test('model cleanup errors are bounded diagnostics and do not reject shutdown', async () => {
  const providerError = Object.assign(new Error('429 credit balance exhausted'), {
    headers: { authorization: 'secret', 'set-cookie': 'secret' },
  });
  const { lifecycle, warnings } = fixture(async () => { throw providerError; });
  await lifecycle.close();
  assert.deepEqual(warnings, ['TTS cleanup failed: 429 credit balance exhausted']);
});

test('pipeline errors unwrap the provider message without printing response headers or stack traces', () => {
  assert.equal(errorMessage({
    type: 'tts_error',
    error: { error: { message: 'credit balance exhausted\nprivate stack trace' }, headers: { secret: true } },
  }), 'credit balance exhausted');
  assert.equal(errorMessage({ headers: { secret: true } }), 'unknown error');
});
