// useLiveCoach — the hint is requested once per FINISHED question: never on
// interim text, never while the interviewer is still speaking.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const coach = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/api/interviewEngine', () => ({
  interviewEngineApi: { coach },
}));

import { useLiveCoach, type LiveTurn } from '../LiveCoach';
import type { IESessionDetail } from '../../../../lib/api/interviewEngine';

const SESSION = { requirements: null, characteristics: null } as unknown as IESessionDetail;

function run(transcript: LiveTurn[], agentSpeaking: boolean) {
  return renderHook(
    (p: { transcript: LiveTurn[]; agentSpeaking: boolean }) =>
      useLiveCoach({ sessionId: 's1', session: SESSION, enabled: true, ...p }),
    { initialProps: { transcript, agentSpeaking } },
  );
}

describe('useLiveCoach hint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    coach.mockReset();
    coach.mockResolvedValue({ coach: { kind: 'good', text: 'Lead with the result.' } });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for a final segment and for the interviewer to stop speaking', async () => {
    const interim: LiveTurn[] = [{ who: 'them', text: 'Tell me about a time', final: false }];
    const hook = run(interim, true);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(coach).not.toHaveBeenCalled();

    const finalQ: LiveTurn[] = [{ who: 'them', text: 'Tell me about a time you failed.', final: true }];
    hook.rerender({ transcript: finalQ, agentSpeaking: true });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(coach).not.toHaveBeenCalled();

    hook.rerender({ transcript: finalQ, agentSpeaking: false });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(coach).toHaveBeenCalledTimes(1);
    expect(coach.mock.calls[0][1]).toEqual({ mode: 'hint', question: 'Tell me about a time you failed.' });
  });

  it('aborts an in-flight hint on unmount', async () => {
    let signal: AbortSignal | undefined;
    coach.mockImplementation((_id: string, _b: unknown, o: { signal?: AbortSignal }) => {
      signal = o.signal;
      return new Promise(() => undefined);
    });
    const hook = run([{ who: 'them', text: 'Why this role?', final: true }], false);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(signal?.aborted).toBe(false);
    hook.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
