// __tests__/server/spokenText.test.ts
//
// toSpokenText (server/src/interview-engine/prompt/spokenText.ts) — the guard
// between LLM-authored blueprint questions and the TTS engine.
//
// The bug it exists for: a zh technical session's first blueprint question was
// written with the type literals in backticks, composeOpeningLine spliced it
// into the line the LiveKit worker speaks VERBATIM, and the candidate got the
// markup read aloud plus a stray ` rendered in the live question card.
//
// The contract under test is narrow on purpose — strip MARKUP, preserve
// MEANING. A regex that tried to verbalize a type literal would mangle
// questions in 9 languages; making a signature speakable is the authoring
// rule's job in InterviewBlueprintAgent.
//
// spokenText.ts is deliberately dependency-free (same reasoning as
// domainExperts.test.ts), which is what makes it importable here without the
// server's nodenext .js-specifier resolution.

import { describe, expect, it } from 'vitest';
import { toSpokenText } from '../../server/src/interview-engine/prompt/spokenText';

describe('toSpokenText — markup that must never reach TTS', () => {
  it('strips the inline-code backticks from the reported zh question', () => {
    const reported =
      '场景是 React/TypeScript 历史记录面板。请实现 `mergeHistory(snapshot, deltas)`。' +
      '可以假设 Item 为 `{ id: string, updatedAt: number }`，' +
      "Delta 为 `{ id: string, op: 'upsert' | 'delete' }`。";
    const spoken = toSpokenText(reported);
    expect(spoken).not.toContain('`');
    // Meaning survives — only the decoration is gone.
    expect(spoken).toContain('mergeHistory(snapshot, deltas)');
    expect(spoken).toContain('场景是 React/TypeScript 历史记录面板');
  });

  it('strips an UNBALANCED backtick — the mid-stream case from the report', () => {
    expect(toSpokenText("Delta 为 `{ id: string, op: 'upsert'")).not.toContain('`');
  });

  it('strips emphasis, headings, bullets, blockquotes and ordered markers', () => {
    expect(toSpokenText('**Walk me** through it')).toBe('Walk me through it');
    expect(toSpokenText('__Walk me__ through it')).toBe('Walk me through it');
    expect(toSpokenText('## Opening\nTell me about yourself')).toBe('Opening Tell me about yourself');
    expect(toSpokenText('- First point\n- Second point')).toBe('First point Second point');
    expect(toSpokenText('1. First\n2. Second')).toBe('First Second');
    expect(toSpokenText('> quoted prompt')).toBe('quoted prompt');
  });

  it('unwraps fenced code blocks and links, and drops emoji', () => {
    expect(toSpokenText('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(toSpokenText('See [our docs](https://example.com/x) first')).toBe('See our docs first');
    expect(toSpokenText('Nice work 🎉 — keep going')).toBe('Nice work — keep going');
  });

  it('flattens to a single line with no stranded punctuation', () => {
    expect(toSpokenText('One\n\nTwo')).toBe('One Two');
    expect(toSpokenText('Walk me through it **,** then stop')).toBe('Walk me through it, then stop');
  });
});

describe('toSpokenText — meaning it must NOT destroy', () => {
  it('keeps snake_case identifiers (a single underscore is not emphasis)', () => {
    expect(toSpokenText('Explain how merge_history handles a late delta')).toContain('merge_history');
  });

  it('keeps a standalone asterisk used as multiplication', () => {
    expect(toSpokenText('What is 3 * 4 in this model?')).toBe('What is 3 * 4 in this model?');
  });

  it('keeps generics and unions — only the authoring rule rewrites those', () => {
    expect(toSpokenText('Assume Partial<Item> and a status of open | closed')).toBe(
      'Assume Partial<Item> and a status of open | closed',
    );
  });

  it('leaves "#1" alone (a heading needs a trailing space)', () => {
    expect(toSpokenText('What is your #1 priority?')).toBe('What is your #1 priority?');
  });

  it('leaves clean CJK prose byte-identical', () => {
    const clean = '首先，请你简单介绍一下你自己和你的背景。';
    expect(toSpokenText(clean)).toBe(clean);
  });

  it('returns empty string for null/undefined so callers keep their fallback', () => {
    expect(toSpokenText(null)).toBe('');
    expect(toSpokenText(undefined)).toBe('');
    expect(toSpokenText('   ')).toBe('');
  });
});
