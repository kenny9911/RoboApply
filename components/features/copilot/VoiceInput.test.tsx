// components/features/copilot/VoiceInput.test.tsx — the Assistant's mic
// button on both brands (parity wave, D5). GoApply shows a one-line notice the
// first time: the browser's own speech service processes the audio.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import { renderWithBrand } from '../../../__tests__/shell/helpers';
import { __resetVoiceAvailability } from '../../../hooks/copilot/useVoiceInput';
import { Toaster } from '../../v3/primitives';
import { __toastStore } from '../../v3/primitives/Toast';
import { VOICE_NOTICE_KEY, VoiceInput } from './VoiceInput';

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
const NOTICE = /Your browser turns your speech into text with its own speech service\. The browser maker processes the audio/;

const view = (brand: 'roboapply' | 'goapply', onText = vi.fn()) =>
  renderWithBrand(
    <>
      <VoiceInput onText={onText} />
      <Toaster />
    </>,
    { brand },
  );

beforeEach(() => {
  FakeRecognition.instances = [];
  __resetVoiceAvailability();
  window.localStorage.removeItem(VOICE_NOTICE_KEY);
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
});
afterEach(() => {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  __resetVoiceAvailability();
  act(() => __toastStore.set(() => []));
});

describe('VoiceInput', () => {
  it('GoApply: the mic button renders, dictation fills the input, and the first use says who processes the speech', async () => {
    const onText = vi.fn();
    view('goapply', onText);
    const mic = await screen.findByTestId('assistant-voice');
    expect(mic).toHaveAccessibleName('Speak your question');
    expect(screen.queryByText(NOTICE)).toBeNull();
    fireEvent.click(mic);
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(last().start).toHaveBeenCalledTimes(1);
    expect(mic).toHaveAttribute('aria-pressed', 'true');
    act(() => last().onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '帮我看看这个职位' } }] }));
    expect(onText).toHaveBeenCalledWith('帮我看看这个职位');
    expect(window.localStorage.getItem(VOICE_NOTICE_KEY)).toBe('1');
  });

  it('GoApply: the notice shows the first time only', async () => {
    window.localStorage.setItem(VOICE_NOTICE_KEY, '1');
    view('goapply');
    fireEvent.click(await screen.findByTestId('assistant-voice'));
    expect(last().start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('RoboApply: the same button, and no notice', async () => {
    view('roboapply');
    fireEvent.click(await screen.findByTestId('assistant-voice'));
    expect(last().start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(window.localStorage.getItem(VOICE_NOTICE_KEY)).toBeNull();
  });

  it('a failed start (the recognition service cannot be reached) removes the button without an error message', async () => {
    view('goapply');
    const mic = await screen.findByTestId('assistant-voice');
    fireEvent.click(mic);
    act(() => last().onerror?.({ error: 'network' }));
    expect(screen.queryByTestId('assistant-voice')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a blocked microphone keeps the button and says so', async () => {
    view('roboapply');
    fireEvent.click(await screen.findByTestId('assistant-voice'));
    act(() => last().onerror?.({ error: 'not-allowed' }));
    expect(screen.getByTestId('assistant-voice')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone access is blocked in this browser.');
  });

  it('no speech recognition in the browser: no button on either brand', async () => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    for (const brand of ['roboapply', 'goapply'] as const) {
      const v = view(brand);
      await act(async () => undefined);
      expect(screen.queryByTestId('assistant-voice')).toBeNull();
      v.unmount();
    }
  });
});
