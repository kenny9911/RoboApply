'use client';

// hooks/copilot/useVoiceInput.ts — speak a question instead of typing it
// (WP-51; F-ORION-01 voice input), with the browser's Web Speech API.
//
// Only where the browser has it (Chrome/Edge/Safari expose
// `SpeechRecognition` or `webkitSpeechRecognition`); otherwise `supported` is
// false and the button is not rendered. Offered on both brands (D5). The
// browser sends the audio to its own recognition service, so:
//   - GoApply tells the user so once (VoiceInput's notice);
//   - where that service cannot be reached (Chrome's recogniser from mainland
//     networks) the first start fails with a network or service error, and
//     the button is then hidden for the rest of the browser session. There is
//     no error dialog: the user types instead.
// Recognised text goes into the box; it is never sent without the user.

import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionCtor = new () => RecognitionLike;

export function speechRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Errors that mean the browser's recognition service itself is out of reach
 * or refused here (not that the user said no to the microphone): dictation
 * cannot work in this session, so the button goes away.
 */
export const VOICE_SERVICE_ERRORS: readonly string[] = ['network', 'service-not-allowed'];

const UNAVAILABLE_KEY = 'ra.voice.unavailable';
let unavailableThisSession = false;

function readUnavailable(): boolean {
  if (unavailableThisSession) return true;
  try {
    return typeof window !== 'undefined' && window.sessionStorage?.getItem(UNAVAILABLE_KEY) === '1';
  } catch {
    return false;
  }
}

function markUnavailable(): void {
  unavailableThisSession = true;
  try {
    window.sessionStorage?.setItem(UNAVAILABLE_KEY, '1');
  } catch {
    // Storage blocked: the in-memory flag still covers this page.
  }
}

/** Test seam: forget that the recognition service failed. */
export function __resetVoiceAvailability(): void {
  unavailableThisSession = false;
  try {
    window.sessionStorage?.removeItem(UNAVAILABLE_KEY);
  } catch {
    // nothing stored
  }
}

export interface VoiceInput {
  supported: boolean;
  listening: boolean;
  /** Last error (`not-allowed` = microphone blocked), or null. */
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceInput({ lang, onText, enabled = true }: { lang: string; onText: (text: string) => void; enabled?: boolean }): VoiceInput {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  // Feature-detect after mount (no SSR mismatch). A session in which the
  // recognition service already failed has no button.
  useEffect(() => {
    setSupported(enabled && speechRecognitionCtor() !== null && !readUnavailable());
  }, [enabled]);

  useEffect(() => () => recRef.current?.abort(), []);

  const start = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || !enabled || readUnavailable()) return;
    recRef.current?.abort();
    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) text += r[0].transcript;
      }
      if (text.trim()) onTextRef.current(text.trim());
    };
    rec.onerror = (e) => {
      const code = e.error ?? 'error';
      setListening(false);
      if (VOICE_SERVICE_ERRORS.includes(code)) {
        // The recogniser is unreachable here: take the button away, say nothing.
        markUnavailable();
        setSupported(false);
        setError(null);
        return;
      }
      setError(code);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setError(null);
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [enabled, lang]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop };
}
