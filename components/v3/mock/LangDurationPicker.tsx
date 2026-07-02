'use client';

// LangDurationPicker — Step 05. Lets the candidate choose the interview
// LANGUAGE (the LLM interviewer answers in this language) and the planned
// DURATION in minutes (the generator time-boxes the interview plan to it).
//
// Language options come from READY_LOCALES (the same set the global switcher
// offers); the default is the user's current UI locale. Duration offers a few
// presets plus the selected interview type's own estimate, defaulting to that.

import { useTranslations } from 'next-intl';
import { READY_LOCALES } from '../../../lib/localeConfig';

interface Props {
  language: string;
  onLanguageChange: (code: string) => void;
  durationMinutes: number;
  onDurationChange: (minutes: number) => void;
  /** The selected interview type's default minutes (for the preset list). */
  typeMinutes: number | null;
}

const BASE_DURATIONS = [15, 30, 45, 60];

function pill(active: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent-text)' : 'var(--rule)'}`,
    background: active ? 'var(--accent-soft)' : 'var(--surface)',
    color: active ? 'var(--accent-text)' : 'var(--text)',
    transition: 'border-color .12s, background .12s, color .12s',
  };
}

export function LangDurationPicker({
  language,
  onLanguageChange,
  durationMinutes,
  onDurationChange,
  typeMinutes,
}: Props) {
  const t = useTranslations('mock');

  const durations = Array.from(
    new Set([...BASE_DURATIONS, ...(typeMinutes ? [typeMinutes] : [])]),
  ).sort((a, b) => a - b);

  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num">05</span>
        <div>
          <div className="iv-step-title">{t('setup.langDuration.title')}</div>
          <div className="iv-step-sub">{t('setup.langDuration.sub')}</div>
        </div>
      </div>

      {/* Language */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.04em' }}
        >
          {t('setup.langDuration.languageLabel')}
        </div>
        <div role="radiogroup" aria-label={t('setup.langDuration.languageLabel')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {READY_LOCALES.map((l) => {
            const active = l.code === language;
            return (
              <button
                key={l.code}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onLanguageChange(l.code)}
                style={pill(active)}
              >
                {l.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Duration */}
      <div>
        <div
          style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '.04em' }}
        >
          {t('setup.langDuration.durationLabel')}
        </div>
        <div role="radiogroup" aria-label={t('setup.langDuration.durationLabel')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {durations.map((m) => {
            const active = m === durationMinutes;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onDurationChange(m)}
                style={pill(active)}
              >
                {t('setup.type.minutes', { minutes: m })}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
