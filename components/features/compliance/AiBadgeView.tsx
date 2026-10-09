'use client';

// AiBadgeView — the visible "AI-generated" label (GoApply: AI 辅助生成).
// Presentational; components/features/market/AiGeneratedBadge decides
// whether to show it (GoApply only).

import { useTranslations } from 'next-intl';

import styles from './compliance.module.css';

export type AiBadgeKind = 'text' | 'document' | 'audio';

export function AiBadgeView({ kind = 'text' }: { kind?: AiBadgeKind }) {
  const t = useTranslations('legal');
  const label = kind === 'document' ? t('aiBadge.document') : kind === 'audio' ? t('aiBadge.audio') : t('aiBadge.text');
  return (
    <span className={styles.aiBadge} title={t('aiBadge.title')} data-ai-label={kind}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6L8 1.5z"
          fill="currentColor"
        />
      </svg>
      {label}
    </span>
  );
}

export default AiBadgeView;
