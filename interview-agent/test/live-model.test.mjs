import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLiveLlm } from '../dist/live-model.js';

test('legacy metadata (llm only) still works unchanged', () => {
  assert.deepEqual(resolveLiveLlm({ llm: { model: 'openai/gpt-6-luna', reasoningEffort: 'high' } }), {
    model: 'openai/gpt-6-luna', reasoningEffort: 'high', source: 'llm',
  });
  assert.deepEqual(resolveLiveLlm({ llm: { model: 'openai/gpt-4.1-mini' } }), { model: 'openai/gpt-4.1-mini', source: 'llm' });
});

test('an explicit liveLlm block wins over llm', () => {
  assert.deepEqual(
    resolveLiveLlm({ llm: { model: 'openai/gpt-6-luna', reasoningEffort: 'high' }, liveLlm: { model: 'openai/gpt-5.4-mini', reasoningEffort: 'low' } }),
    { model: 'openai/gpt-5.4-mini', reasoningEffort: 'low', source: 'liveLlm' },
  );
});

test('a liveLlm block with only an effort overrides the effort of llm', () => {
  assert.deepEqual(
    resolveLiveLlm({ llm: { model: 'openai/gpt-6-luna', reasoningEffort: 'high' }, liveLlm: { reasoningEffort: 'low' } }),
    { model: 'openai/gpt-6-luna', reasoningEffort: 'low', source: 'llm' },
  );
});

test('invalid efforts are dropped and a missing model resolves to null', () => {
  assert.deepEqual(resolveLiveLlm({ llm: { model: 'm', reasoningEffort: 'turbo' } }), { model: 'm', source: 'llm' });
  assert.equal(resolveLiveLlm({}), null);
  assert.equal(resolveLiveLlm({ llm: { model: '  ' } }), null);
});
