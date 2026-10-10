// hooks/copilot/useVoiceInput.test.ts — dictation with the browser's Web
// Speech API (parity wave: offered on both brands). The button exists only
// where the browser has speech recognition, and goes away for the session
// when the browser's own recognition service cannot be reached (Chrome's is
// unreachable from mainland networks): no error state, no dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { VOICE_SERVICE_ERRORS, __resetVoiceAvailability, speechRecognitionCtor, useVoiceInput } from './useVoiceInput';

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = true;
  interimResults = true;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.instances.push(this);
  }
}
const last = () => FakeRecognition.instances[FakeRecognition.instances.length - 1]!;
const install = () => ((window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition);
const uninstall = () => {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
};

beforeEach(() => {
  FakeRecognition.instances = [];
  __resetVoiceAvailability();
  install();
});
afterEach(() => {
  uninstall();
  __resetVoiceAvailability();
});

describe('useVoiceInput', () => {
  it('is supported where the browser has speech recognition, and not otherwise', async () => {
    const on = renderHook(() => useVoiceInput({ lang: 'zh', onText: vi.fn() }));
    await waitFor(() => expect(on.result.current.supported).toBe(true));
    on.unmount();
    uninstall();
    expect(speechRecognitionCtor()).toBeNull();
    const off = renderHook(() => useVoiceInput({ lang: 'zh', onText: vi.fn() }));
    await act(async () => undefined);
    expect(off.result.current.supported).toBe(false);
  });

  it('dictation fills the input with the final text, in the page language', async () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ lang: 'zh', onText }));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(last().lang).toBe('zh');
    expect(last().start).toHaveBeenCalledTimes(1);
    act(() => last().onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: ' 帮我找上海的数据分析师职位 ' } }, { isFinal: false, 0: { transcript: 'ignored' } }] }));
    expect(onText).toHaveBeenCalledWith('帮我找上海的数据分析师职位');
    act(() => last().onend?.());
    expect(result.current.listening).toBe(false);
  });

  it.each(VOICE_SERVICE_ERRORS)('a start that fails with "%s" removes the button for the session, with no error to show', async (code) => {
    const first = renderHook(() => useVoiceInput({ lang: 'zh', onText: vi.fn() }));
    await waitFor(() => expect(first.result.current.supported).toBe(true));
    act(() => first.result.current.start());
    act(() => last().onerror?.({ error: code }));
    expect(first.result.current.supported).toBe(false);
    expect(first.result.current.listening).toBe(false);
    expect(first.result.current.error).toBeNull();
    // Pressing again does nothing, and no new recogniser is made.
    const made = FakeRecognition.instances.length;
    act(() => first.result.current.start());
    expect(FakeRecognition.instances).toHaveLength(made);
    first.unmount();
    // The rest of the session: another composer (the rail, the full page) has no button either.
    const second = renderHook(() => useVoiceInput({ lang: 'zh', onText: vi.fn() }));
    await act(async () => undefined);
    expect(second.result.current.supported).toBe(false);
    expect(window.sessionStorage.getItem('ra.voice.unavailable')).toBe('1');
  });

  it('a blocked microphone is the user’s choice: the button stays and the error is reported', async () => {
    const { result } = renderHook(() => useVoiceInput({ lang: 'en', onText: vi.fn() }));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.start());
    act(() => last().onerror?.({ error: 'not-allowed' }));
    expect(result.current.supported).toBe(true);
    expect(result.current.error).toBe('not-allowed');
    // "no-speech" (silence) keeps the button too.
    act(() => result.current.start());
    act(() => last().onerror?.({ error: 'no-speech' }));
    expect(result.current.supported).toBe(true);
    expect(window.sessionStorage.getItem('ra.voice.unavailable')).toBeNull();
  });

  it('enabled: false never offers it', async () => {
    const { result } = renderHook(() => useVoiceInput({ lang: 'en', onText: vi.fn(), enabled: false }));
    await act(async () => undefined);
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(FakeRecognition.instances).toHaveLength(0);
  });
});
