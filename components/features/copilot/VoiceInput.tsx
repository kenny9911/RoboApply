'use client';

// VoiceInput — speak a question into the box (Web Speech API where the
// browser has it; hidden otherwise, see useVoiceInput). Offered on both
// brands (D5). The browser turns the speech into text with its own service,
// so on GoApply the first use says so in one line (the audio goes to the
// browser maker, which may process it outside mainland China). The line is a
// notice toast: it stays out of the composer row, which has no room for a
// sentence on a phone. When that
// service cannot be reached the button goes away for the session, with no
// error dialog (useVoiceInput).

import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { useVoiceInput } from '../../../hooks/copilot';
import { useBrand } from '../../../lib/brand';
import { IconMic, IconMicOff, toast } from '../../v3/primitives';
import styles from './copilot.module.css';

/** Set once the GoApply notice was shown on this device (a convenience, not a consent record). */
export const VOICE_NOTICE_KEY = 'ra.voice.vendorNoticeSeen';

function noticeSeen(): boolean {
  try {
    return window.localStorage?.getItem(VOICE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberNotice(): void {
  try {
    window.localStorage?.setItem(VOICE_NOTICE_KEY, '1');
  } catch {
    // Storage blocked: the notice shows again next time, which is harmless.
  }
}

export function VoiceInput({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const t = useTranslations('assistant.voice');
  const locale = useLocale();
  const brand = useBrand();
  const voice = useVoiceInput({ lang: locale, onText, enabled: true });
  const { start } = voice;
  const vendorNotice = t('vendorNotice');
  const begin = useCallback(() => {
    // GoApply, first use on this device: say who processes the speech.
    if (brand.market === 'cn' && !noticeSeen()) {
      toast({ message: vendorNotice, tone: 'info', durationMs: 12_000 });
      rememberNotice();
    }
    start();
  }, [brand.market, start, vendorNotice]);
  if (!voice.supported) return null;
  return (
    <>
      <button
        type="button"
        className={styles.iconBtn}
        aria-pressed={voice.listening}
        aria-label={voice.listening ? t('stop') : t('start')}
        title={voice.listening ? t('stop') : t('start')}
        disabled={disabled}
        onClick={voice.listening ? voice.stop : begin}
        data-testid="assistant-voice"
      >
        {voice.listening ? <IconMicOff size={18} /> : <IconMic size={18} />}
      </button>
      {voice.listening ? (
        <span className="sr-only" role="status">
          {t('listening')}
        </span>
      ) : null}
      {voice.error === 'not-allowed' ? (
        <span className={styles.alert} role="alert">
          {t('blocked')}
        </span>
      ) : null}
    </>
  );
}
