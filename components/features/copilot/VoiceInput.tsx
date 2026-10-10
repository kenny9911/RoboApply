'use client';

// VoiceInput — speak a question into the box (Web Speech API where the
// browser has it; hidden otherwise and on GoApply, see useVoiceInput).

import { useLocale, useTranslations } from 'next-intl';

import { useVoiceInput } from '../../../hooks/copilot';
import { useBrand } from '../../../lib/brand';
import { IconMic, IconMicOff } from '../../v3/primitives';
import styles from './copilot.module.css';

export function VoiceInput({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const t = useTranslations('assistant.voice');
  const locale = useLocale();
  const brand = useBrand();
  const voice = useVoiceInput({ lang: locale, onText, enabled: brand.market !== 'cn' });
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
        onClick={voice.listening ? voice.stop : voice.start}
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
