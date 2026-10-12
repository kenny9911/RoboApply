// @vitest-environment node
//
// WP-64: the writer's JSON is parsed defensively (an unparseable answer is
// empty, which the service treats as a failed attempt), and its prompt names
// the honesty rules. No model is called here.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { OfferWriterAgent, parseOfferWriterOutput } from './OfferWriterAgent.js';

describe('parseOfferWriterOutput', () => {
  it('reads strict JSON, fenced JSON and JSON inside prose; caps the points', () => {
    expect(parseOfferWriterOutput('{"text":" Hi ","talkingPoints":["a","", "b"]}')).toEqual({ text: 'Hi', talkingPoints: ['a', 'b'] });
    expect(parseOfferWriterOutput('```json\n{"text":"Hi"}\n```')).toEqual({ text: 'Hi', talkingPoints: [] });
    expect(parseOfferWriterOutput('Sure: {"text":"Hi","talkingPoints":["1","2","3","4","5","6","7"]} done').talkingPoints).toHaveLength(6);
  });

  it('returns empty text for anything else', () => {
    expect(parseOfferWriterOutput('')).toEqual({ text: '', talkingPoints: [] });
    expect(parseOfferWriterOutput('not json')).toEqual({ text: '', talkingPoints: [] });
    expect(parseOfferWriterOutput('[1,2]')).toEqual({ text: '', talkingPoints: [] });
  });
});

describe('OfferWriterAgent prompt', () => {
  it('forbids numbers outside FACTS and puts the facts and task in the user message', () => {
    const agent = new OfferWriterAgent() as unknown as { getAgentPrompt(): string; formatInput(i: unknown, l?: string): string };
    const system = agent.getAgentPrompt();
    expect(system).toContain('Use ONLY the numbers in FACTS');
    expect(system).toContain('Write every number in Arabic digits');
    expect(system).toContain('never contact anyone');
    const user = agent.formatInput({ mode: 'negotiation', locale: 'en', facts: 'FOCUS OFFER: base pay: 1', focus: 'start_date', retryNote: 'RETRY' }, 'en');
    expect(user).toContain('## FACTS\nFOCUS OFFER: base pay: 1');
    expect(user).toContain('different start date');
    expect(user).toContain('RETRY');
    expect(agent.formatInput({ mode: 'explain', locale: 'zh', facts: 'x' }, 'zh')).toContain('Do not pick a winner');
  });
});
