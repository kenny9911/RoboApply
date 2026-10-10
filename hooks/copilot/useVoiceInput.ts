'use client';

// hooks/copilot/useVoiceInput.ts — speak a question instead of typing it
// (WP-51; F-ORION-01 voice input), with the browser's Web Speech API.
//
// Only where the browser has it (Chrome/Edge/Safari expose
// `SpeechRecognition` or `webkitSpeechRecognition`); otherwise `supported` is
// false and the button is not rendered. Not offered on GoApply: browsers send
// the audio to their own recognition service, which may be outside mainland
// China (CN data-egress rules; the voice path there waits for a domestic ASR).
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

  // Feature-detect after mount (no SSR mismatch).
  useEffect(() => {
    setSupported(enabled && speechRecognitionCtor() !== null);
  }, [enabled]);

  useEffect(() => () => recRef.current?.abort(), []);

  const start = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || !enabled) return;
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
      setError(e.error ?? 'error');
      setListening(false);
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
