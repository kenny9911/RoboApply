// @vitest-environment node
//
// WP-22: the fix panel's Shorter / Longer / Stronger reach the model on
// summary issues too. RAResumeRewriteAgent's summary prompt carries the
// action (and its guidance) when one other than 'improve' is given; the
// editor's plain summary rewrite ('improve') keeps its old prompt.

import { describe, expect, it } from 'vitest';

import { RAResumeRewriteAgent, type RAResumeRewriteInput } from '../../roboapply/v2/agents/RAResumeRewriteAgent.js';

class Probe extends RAResumeRewriteAgent {
  prompt(input: RAResumeRewriteInput): string {
    return this.formatInput(input, 'en');
  }
}

const RESUME = '## Summary\nBackend engineer who builds payment systems.\n## Experience\n- Built a ledger.';

describe('RAResumeRewriteAgent summary prompt', () => {
  it.each([
    ['shorten', /shorter than the current summary/],
    ['expand', /a little longer than the current summary/],
    ['confident', /confident, ownership voice/],
  ] as const)('carries ACTION: %s', (action, guidance) => {
    const text = new Probe().prompt({ mode: 'summary', text: 'Backend engineer who builds payment systems.', action, resumeMarkdown: RESUME });
    expect(text).toContain(`ACTION: ${action}`);
    expect(text).toMatch(guidance);
    expect(text).toContain('Produce 3 summary options');
  });

  it('leaves the plain summary rewrite unchanged (no action / improve)', () => {
    for (const action of [undefined, 'improve'] as const) {
      const text = new Probe().prompt({ mode: 'summary', text: 'Engineer.', action, resumeMarkdown: RESUME });
      expect(text).not.toContain('ACTION:');
    }
  });

  it('bullet mode still carries its action', () => {
    expect(new Probe().prompt({ mode: 'bullet', text: 'Built a ledger.', action: 'shorten', resumeMarkdown: RESUME })).toContain('ACTION: shorten');
  });
});
