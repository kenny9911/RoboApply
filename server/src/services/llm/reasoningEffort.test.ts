// server/src/services/llm/reasoningEffort.test.ts
//
// Unit tests for the shared reasoning-effort resolver. Focus: the global
// LLM_REASONING_EFFORT dial reaches providers whose API accepts the value,
// falls through silently on providers whose ladder excludes it (DeepSeek takes
// high|max only), and that the OpenAI-direct model gate keeps `reasoning_effort`
// away from the non-reasoning families that 400 on it.
// Run: npx vitest run server/src/services/llm/reasoningEffort.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEEPSEEK_EFFORTS,
  OPENAI_STYLE_EFFORTS,
  GLOBAL_REASONING_EFFORT_ENV,
  modelSupportsReasoningEffort,
  parseReasoningEffort,
  resolveReasoningEffort,
} from './reasoningEffort.js';

const TOUCHED = [GLOBAL_REASONING_EFFORT_ENV, 'DEEPSEEK_REASONING_EFFORT'];

describe('parseReasoningEffort', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(parseReasoningEffort('  Medium ')).toBe('medium');
    expect(parseReasoningEffort('HIGH')).toBe('high');
  });

  it('rejects unknown and non-string values', () => {
    expect(parseReasoningEffort('extreme')).toBeUndefined();
    expect(parseReasoningEffort('')).toBeUndefined();
    expect(parseReasoningEffort(undefined)).toBeUndefined();
    expect(parseReasoningEffort(3)).toBeUndefined();
  });
});

describe('resolveReasoningEffort', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    for (const k of TOUCHED) delete process.env[k];
  });

  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('omits the field entirely when nothing is configured', () => {
    expect(resolveReasoningEffort({ allow: OPENAI_STYLE_EFFORTS })).toBeUndefined();
  });

  it('applies the global dial to an OpenAI-style ladder', () => {
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'medium';
    expect(resolveReasoningEffort({ allow: OPENAI_STYLE_EFFORTS })).toBe('medium');
  });

  it('ignores a global value the provider ladder does not accept', () => {
    // DeepSeek takes high|max only, so a global `medium` must be dropped
    // rather than sent and rejected upstream.
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'medium';
    expect(resolveReasoningEffort({ allow: DEEPSEEK_EFFORTS })).toBeUndefined();
  });

  it('lets a provider env var win over the global dial', () => {
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'medium';
    process.env.DEEPSEEK_REASONING_EFFORT = 'max';
    expect(
      resolveReasoningEffort({ envVars: ['DEEPSEEK_REASONING_EFFORT'], allow: DEEPSEEK_EFFORTS }),
    ).toBe('max');
  });

  it('lets DB tuning win over every env tier', () => {
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'medium';
    process.env.DEEPSEEK_REASONING_EFFORT = 'max';
    expect(
      resolveReasoningEffort({
        tuned: 'high',
        envVars: ['DEEPSEEK_REASONING_EFFORT'],
        allow: DEEPSEEK_EFFORTS,
      }),
    ).toBe('high');
  });

  it('falls through an unsupported higher tier to a usable lower one', () => {
    // Tuned `max` is DeepSeek-only; on the OpenAI ladder it must not be sent,
    // and the global dial below it still applies.
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'medium';
    expect(resolveReasoningEffort({ tuned: 'max', allow: OPENAI_STYLE_EFFORTS })).toBe('medium');
  });

  it('ignores a malformed global value instead of throwing', () => {
    process.env[GLOBAL_REASONING_EFFORT_ENV] = 'nonsense';
    expect(resolveReasoningEffort({ allow: OPENAI_STYLE_EFFORTS })).toBeUndefined();
  });
});

describe('modelSupportsReasoningEffort', () => {
  it('accepts the GPT-5+ line, prefixed or bare', () => {
    // The configured default; both routing paths' id shapes must pass.
    expect(modelSupportsReasoningEffort('gpt-5.6-luna')).toBe(true);
    expect(modelSupportsReasoningEffort('openai/gpt-5.6-luna-pro')).toBe(true);
    expect(modelSupportsReasoningEffort('gpt-5.5')).toBe(true);
    expect(modelSupportsReasoningEffort('gpt-6')).toBe(true);
  });

  it('accepts the o-series reasoners', () => {
    expect(modelSupportsReasoningEffort('o1')).toBe(true);
    expect(modelSupportsReasoningEffort('o3-mini')).toBe(true);
    expect(modelSupportsReasoningEffort('o4-mini')).toBe(true);
  });

  it('rejects the non-reasoning families that 400 on the field', () => {
    expect(modelSupportsReasoningEffort('gpt-4o')).toBe(false);
    expect(modelSupportsReasoningEffort('gpt-4.1')).toBe(false);
    expect(modelSupportsReasoningEffort('gpt-4o-mini')).toBe(false);
    // -chat variants are the non-reasoning members of an otherwise-eligible line.
    expect(modelSupportsReasoningEffort('gpt-5-chat-latest')).toBe(false);
    expect(modelSupportsReasoningEffort('')).toBe(false);
    expect(modelSupportsReasoningEffort(undefined)).toBe(false);
  });
});
