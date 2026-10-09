import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientEndHandler, CLIENT_END_REASON } from '../dist/client-end.js';

function harness({ started = true, closeSession, interrupt, stopInput } = {}) {
  const log = [];
  const warnings = [];
  const handler = createClientEndHandler({
    stopInput: stopInput ?? (() => log.push('stopInput')),
    interrupt: interrupt ?? (() => log.push('interrupt')),
    closeLifecycle: async () => { log.push('closeLifecycle'); },
    closeSession: closeSession ?? (async () => { log.push('closeSession'); }),
    shutdown: (reason) => log.push(`shutdown:${reason}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    sessionStarted: () => started,
    warn: (m) => warnings.push(m),
    closeTimeoutMs: 30,
  });
  return { handler, log, warnings };
}

test('end: stops input, interrupts, latches the lifecycle, closes the session, then shuts down', async () => {
  const { handler, log } = harness();
  await handler();
  assert.deepEqual(log, ['stopInput', 'interrupt', 'closeLifecycle', 'closeSession', `shutdown:${CLIENT_END_REASON}`]);
  assert.equal(CLIENT_END_REASON, 'client_end');
});

test('end: repeated end messages share one run', async () => {
  const { handler, log } = harness();
  const a = handler();
  const b = handler();
  assert.equal(a, b);
  await Promise.all([a, b, handler()]);
  assert.equal(log.filter((l) => l.startsWith('shutdown')).length, 1);
});

test('end before the session started skips interrupt/close but still shuts the job down', async () => {
  const { handler, log } = harness({ started: false });
  await handler();
  assert.deepEqual(log, ['stopInput', 'closeLifecycle', `shutdown:${CLIENT_END_REASON}`]);
});

test('end: a wedged session close is bounded and step failures never block shutdown', async () => {
  const { handler, log, warnings } = harness({
    closeSession: () => new Promise(() => {}),
    interrupt: () => { throw new Error('not running'); },
    stopInput: () => { throw new Error('no input'); },
  });
  await handler();
  assert.deepEqual(log, ['closeLifecycle', `shutdown:${CLIENT_END_REASON}`]);
  assert.equal(warnings.length, 2);
});

test('end: a rejected session close is logged and the job still shuts down', async () => {
  const { handler, log, warnings } = harness({ closeSession: async () => { throw new Error('boom'); } });
  await handler();
  assert.equal(log.at(-1), `shutdown:${CLIENT_END_REASON}`);
  assert.match(warnings[0], /boom/);
});
