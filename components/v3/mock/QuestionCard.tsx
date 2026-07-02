'use client';

// QuestionCard — the current question on the left stage (proto `.iv-question`).
// Shows "Question N / total", the prompt, a toggle-able coach hint, and a Skip
// affordance. The prompt + hint come from `mock.start` (LLM/stub-authored), so
// both render through the sanitized Markdown primitive (CLAUDE.md rule).

import { useTranslations } from 'next-intl';
import { IconSparkle } from '../primitives/Iconset';
import { Markdown } from '../primitives/Markdown';

interface Props {
  index: number;
  total: number;
  prompt: string;
  hint: string;
  hintOpen: boolean;
  onToggleHint: () => void;
  onSkip: () => void;
}

export function QuestionCard({
  index,
  total,
  prompt,
  hint,
  hintOpen,
  onToggleHint,
  onSkip,
}: Props) {
  const t = useTranslations('mock');
  return (
    <div className="iv-question" key={index}>
      <div className="iv-question-num">
        {t('live.questionNum', { current: index + 1, total })}
      </div>
      <div className="iv-question-text">
        <Markdown>{prompt}</Markdown>
      </div>
      <div className="iv-question-actions">
        <button
          type="button"
          className="btn ghost"
          style={{ padding: '6px 10px', fontSize: 12 }}
          onClick={onToggleHint}
        >
          <IconSparkle size={12} />
          {hintOpen ? t('live.hideHint') : t('live.showHint')}
        </button>
        <button
          type="button"
          className="btn ghost"
          style={{ padding: '6px 10px', fontSize: 12 }}
          onClick={onSkip}
        >
          {t('live.skip')}
        </button>
      </div>
      {hintOpen ? (
        <div className="iv-hint">
          <span className="iv-hint-lbl">{t('live.coachHint')}</span>
          <Markdown>{hint}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
