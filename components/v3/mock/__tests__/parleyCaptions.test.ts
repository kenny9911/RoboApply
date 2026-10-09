import { describe, expect, it } from 'vitest';
import { agentStateFor, ParleyCaptions } from '../parley/parleyCaptions';

describe('agentStateFor', () => {
  it('maps Parley engine states onto the page vocabulary', () => {
    expect(agentStateFor('greeting')).toBe('speaking');
    expect(agentStateFor('speaking')).toBe('speaking');
    expect(agentStateFor('listening')).toBe('listening');
    expect(agentStateFor('user_speaking')).toBe('listening');
    expect(agentStateFor('thinking')).toBe('thinking');
    expect(agentStateFor('ready')).toBe('connecting');
    expect(agentStateFor('reconnecting')).toBeNull();
    expect(agentStateFor('ended')).toBeNull();
  });
});

describe('ParleyCaptions', () => {
  it('finalizes the candidate placeholder in place and starts a new one after', () => {
    const c = new ParleyCaptions();
    const a = c.userPartial('I led');
    const b = c.userPartial('I led the migration');
    expect(a?.id).toBe(b?.id);
    expect(b).toMatchObject({ who: 'you', final: false });
    const done = c.userFinal('t1', 'I led the migration.');
    expect(done).toEqual({ id: a!.id, who: 'you', text: 'I led the migration.', final: true });
    expect(c.userPartial('Next')!.id).not.toBe(a!.id);
    expect(c.userPartial('   ')).toBeNull();
  });

  it('reopens a retracted line until its merged final arrives', () => {
    const c = new ParleyCaptions();
    c.userPartial('So');
    const first = c.userFinal('t1', 'So.');
    const reopened = c.userRetracted('t1', 'So')!;
    expect(reopened).toEqual({ id: first.id, who: 'you', text: 'So', final: false });
    expect(c.userPartial('So we sharded')!.id).toBe(first.id);
    expect(c.userFinal('t2', 'So we sharded the table.')).toMatchObject({ id: first.id, final: true });
    expect(c.userRetracted('unknown', 'x')).toBeNull();
  });

  it('builds interviewer text from the sentences actually played', () => {
    const c = new ParleyCaptions();
    expect(c.agentSegment('a1', 0, 'Thanks.').text).toBe('Thanks.');
    expect(c.agentSegment('a1', 1, 'What broke first?')).toEqual({
      id: 'parley-them-a1', who: 'them', text: 'Thanks. What broke first?', final: false,
    });
    expect(c.agentDone('a1', 'Thanks. What broke first?')).toMatchObject({ final: true });
    expect(new ParleyCaptions().agentSegment('z', 1, '然后呢？').text).toBe('然后呢？');
    const zh = new ParleyCaptions();
    zh.agentSegment('a', 0, '好的。');
    expect(zh.agentSegment('a', 1, '请继续。').text).toBe('好的。请继续。');
  });

  it('a barge-in keeps only what was heard; an unheard reply leaves nothing', () => {
    const c = new ParleyCaptions();
    c.agentSegment('a1', 0, 'Let me ask about');
    expect(c.agentInterrupted('a1', 'Let me ask')).toEqual({ id: 'parley-them-a1', who: 'them', text: 'Let me ask', final: true });
    expect(c.agentInterrupted('a2', '')).toBeNull();
  });
});
