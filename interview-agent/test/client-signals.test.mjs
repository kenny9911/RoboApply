import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLIENT_READY_ATTRIBUTE,
  ClientReadyGate,
  DEFAULT_CLIENT_READY_TIMEOUT_MS,
  hasClientReadyAttribute,
  parseClientMessage,
  resolveClientReadyTimeoutMs,
} from '../dist/client-signals.js';

const enc = (v) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

test('the attribute name and default timeout match the browser contract', () => {
  assert.equal(CLIENT_READY_ATTRIBUTE, 'ie.client_ready');
  assert.equal(DEFAULT_CLIENT_READY_TIMEOUT_MS, 5000);
  assert.equal(resolveClientReadyTimeoutMs(undefined), 5000);
  assert.equal(resolveClientReadyTimeoutMs(''), 5000);
  assert.equal(resolveClientReadyTimeoutMs('garbage'), 5000);
  assert.equal(resolveClientReadyTimeoutMs('0'), 5000);
  assert.equal(resolveClientReadyTimeoutMs('12000'), 12000);
});

test('data messages: client_ready and end on topic ie (or no topic) are recognized', () => {
  assert.deepEqual(parseClientMessage(enc({ type: 'client_ready' }), 'ie'), { type: 'client_ready' });
  assert.deepEqual(parseClientMessage(enc({ type: 'client_ready' })), { type: 'client_ready' });
  assert.deepEqual(parseClientMessage(enc({ type: 'end' }), 'ie'), { type: 'end' });
});

test('data messages: other topics, junk payloads and unknown types are ignored', () => {
  assert.equal(parseClientMessage(enc({ type: 'end' }), 'chat'), null);
  assert.equal(parseClientMessage(enc('not json'), 'ie'), null);
  assert.equal(parseClientMessage(enc('null'), 'ie'), null);
  assert.equal(parseClientMessage(enc({ type: 'something_else' }), 'ie'), null);
  assert.equal(parseClientMessage(enc([1, 2]), 'ie'), null);
});

test('the attribute counts only when set to 1/true', () => {
  assert.equal(hasClientReadyAttribute({ 'ie.client_ready': '1' }), true);
  assert.equal(hasClientReadyAttribute({ 'ie.client_ready': 'true' }), true);
  assert.equal(hasClientReadyAttribute({ 'ie.client_ready': '0' }), false);
  assert.equal(hasClientReadyAttribute({}), false);
  assert.equal(hasClientReadyAttribute(undefined), false);
});

test('gate: an attribute already present when the worker joins opens it (late-join race)', async () => {
  const gate = new ClientReadyGate();
  assert.equal(gate.observeAttributes({ 'ie.client_ready': '1' }), true);
  assert.equal(await gate.whenReady, 'attribute');
  assert.equal(gate.ready, true);
});

test('gate: the legacy data message opens it, and only the first signal wins', async () => {
  const gate = new ClientReadyGate();
  assert.equal(gate.observeAttributes({ other: 'x' }), false);
  assert.equal(gate.ready, false);
  assert.equal(gate.markReady('data'), true);
  assert.equal(gate.observeAttributes({ 'ie.client_ready': '1' }), false);
  assert.equal(gate.markReady('data'), false);
  assert.equal(await gate.whenReady, 'data');
  assert.equal(gate.source, 'data');
});

test('gate: stays pending until a signal arrives (the worker races it against the timeout)', async () => {
  const gate = new ClientReadyGate();
  const result = await Promise.race([
    gate.whenReady,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);
  assert.equal(result, 'timeout');
});
