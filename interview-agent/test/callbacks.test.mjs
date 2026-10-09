import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chunk,
  classifyStatus,
  createPoster,
  EagerTurnDeduper,
  TranscriptSender,
  TurnClock,
  TRANSCRIPT_MAX_BATCH,
} from '../dist/callbacks.js';

function fakeFetch(statuses) {
  const calls = [];
  const queue = [...statuses];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length ? queue.shift() : 200;
    if (next instanceof Error) throw next;
    return { ok: next >= 200 && next < 300, status: next };
  };
  return { fn, calls };
}

const noSleep = async () => {};

test('status classification: 2xx ok, 5xx/408/409/429 retry, other 4xx final', () => {
  assert.equal(classifyStatus(200), 'ok');
  assert.equal(classifyStatus(204), 'ok');
  assert.equal(classifyStatus(500), 'retry');
  assert.equal(classifyStatus(503), 'retry');
  assert.equal(classifyStatus(409), 'retry');
  assert.equal(classifyStatus(429), 'retry');
  assert.equal(classifyStatus(408), 'retry');
  assert.equal(classifyStatus(400), 'final');
  assert.equal(classifyStatus(401), 'final');
  assert.equal(classifyStatus(403), 'final');
  assert.equal(classifyStatus(404), 'final');
});

test('poster retries 5xx and network errors at most 3 times with backoff, then reports lost', async () => {
  const { fn, calls } = fakeFetch([503, new Error('ECONNREFUSED'), 500, 502]);
  const sleeps = [];
  const post = createPoster({ baseUrl: 'http://cp/', secret: 's', fetchImpl: fn, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(await post('/x', { a: 1 }), 'lost');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [600, 1200, 1800]);
  assert.equal(calls[0].url, 'http://cp/x');
  assert.equal(calls[0].init.headers['x-interview-callback-secret'], 's');
});

test('poster: a transient 5xx then success is delivered; 409/429 retry', async () => {
  const a = fakeFetch([500, 200]);
  assert.equal(await createPoster({ baseUrl: 'http://cp', secret: 's', fetchImpl: a.fn, sleep: noSleep })('/x', {}), 'delivered');
  assert.equal(a.calls.length, 2);
  const b = fakeFetch([409, 429, 201]);
  assert.equal(await createPoster({ baseUrl: 'http://cp', secret: 's', fetchImpl: b.fn, sleep: noSleep })('/x', {}), 'delivered');
  assert.equal(b.calls.length, 3);
});

test('poster: other 4xx are final and never retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const { fn, calls } = fakeFetch([status, 200]);
    const warnings = [];
    const post = createPoster({ baseUrl: 'http://cp', secret: 's', fetchImpl: fn, sleep: noSleep, warn: (m) => warnings.push(m) });
    assert.equal(await post('/x', {}), 'rejected');
    assert.equal(calls.length, 1);
    assert.match(warnings[0], new RegExp(`HTTP ${status}`));
  }
});

test('poster with no base URL skips without calling fetch', async () => {
  const { fn, calls } = fakeFetch([]);
  assert.equal(await createPoster({ baseUrl: '', secret: 's', fetchImpl: fn })('/x', {}), 'skipped');
  assert.equal(calls.length, 0);
});

test('turn clock: timestamps strictly increase per role even within one millisecond', () => {
  const clock = new TurnClock(() => 1000);
  assert.equal(clock.next('interviewer'), 1000);
  assert.equal(clock.next('interviewer'), 1001);
  assert.equal(clock.next('candidate'), 1000);
  assert.equal(clock.next('interviewer'), 1002);
});

test('transcript turns carry key = role:ts and batches never exceed 100 turns', async () => {
  const bodies = [];
  const post = async (_path, body) => { bodies.push(body); return 'delivered'; };
  const sender = new TranscriptSender(post, '/t', { now: () => 5000 });
  for (let i = 0; i < 250; i += 1) sender.add(i % 2 ? 'candidate' : 'interviewer', `turn ${i}`);
  await sender.flush();
  assert.equal(TRANSCRIPT_MAX_BATCH, 100);
  assert.deepEqual(bodies.map((b) => b.turns.length), [100, 100, 50]);
  const all = bodies.flatMap((b) => b.turns);
  assert.equal(all.length, 250);
  for (const t of all) assert.equal(t.key, `${t.role}:${t.ts}`);
  assert.equal(new Set(all.map((t) => t.key)).size, 250);
  assert.deepEqual(all.map((t) => t.text), Array.from({ length: 250 }, (_, i) => `turn ${i}`));
  assert.equal(sender.pending, 0);
});

test('a lost batch is re-queued at the front in order; a rejected batch is dropped', async () => {
  const results = ['delivered', 'lost'];
  const bodies = [];
  const post = async (_p, body) => { bodies.push(body); return results.shift() ?? 'delivered'; };
  const sender = new TranscriptSender(post, '/t', { batchSize: 2 });
  ['a', 'b', 'c', 'd', 'e'].forEach((t) => sender.add('candidate', t));
  await sender.flush();
  assert.equal(sender.pending, 3); // c, d (lost) + e
  await sender.flush();
  assert.equal(sender.pending, 0);
  assert.deepEqual(bodies.map((b) => b.turns.map((t) => t.text)), [['a', 'b'], ['c', 'd'], ['c', 'd'], ['e']]);
  // Same keys on the retry → the control plane dedupes.
  assert.deepEqual(bodies[1].turns.map((t) => t.key), bodies[2].turns.map((t) => t.key));

  const warnings = [];
  const rejecting = new TranscriptSender(async () => 'rejected', '/t', { warn: (m) => warnings.push(m) });
  rejecting.add('candidate', 'x');
  await rejecting.flush();
  assert.equal(rejecting.pending, 0);
  assert.equal(warnings.length, 1);
});

test('concurrent flushes share one pass and blank turns are ignored', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const post = async () => { calls += 1; await gate; return 'delivered'; };
  const sender = new TranscriptSender(post, '/t');
  assert.equal(sender.add('candidate', '   '), null);
  sender.add('candidate', 'hello');
  const a = sender.flush();
  const b = sender.flush();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('chunk splits into fixed-size slices', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 100), []);
});

test('eager interviewer turns swallow their playout echo once (exact or interrupted prefix)', () => {
  const d = new EagerTurnDeduper();
  d.remember('Hi Kenny, I am Alex. Thanks for joining today.');
  d.remember('Tell me about a project you led.');
  assert.equal(d.consume('Hi Kenny, I am Alex.  Thanks for joining today.'), true);
  assert.equal(d.consume('Hi Kenny, I am Alex. Thanks for joining today.'), false); // consumed
  assert.equal(d.consume('Tell me about a pro'), true); // interrupted mid-question
  assert.equal(d.consume('A completely different LLM turn.'), false);
  assert.equal(d.size, 0);
});
