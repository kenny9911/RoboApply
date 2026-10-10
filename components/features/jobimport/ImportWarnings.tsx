'use client';

// ImportWarnings — lines of a job post that are common in scams, quoted from
// the post itself (WP-35; rule-based signals and GoApply fraud rules from the
// market hooks, WP-41). Shown before and after saving. Never a verdict: it
// says what the post says and asks the user to look carefully.

import { useTranslations } from 'next-intl';

import type { ImportWarning } from '../../../lib/api/contracts/jobs/import';
import styles from './JobImport.module.css';

const KNOWN_RULES = new Set(['intl_pay_to_apply', 'intl_fee_required', 'intl_messaging_app_only']);

export function ImportWarnings({ warnings }: { warnings: readonly ImportWarning[] }) {
  const t = useTranslations('jobImport.warnings');
  if (!warnings.length) return null;
  return (
    <div className={styles.warnings} role="note" data-testid="import-warnings">
      <p className={styles.warningsTitle}>{t('title')}</p>
      <p className={styles.meta}>{t('intro')}</p>
      <ul className={styles.warningList}>
        {warnings.map((w) => (
          <li key={`${w.rule}:${w.evidence}`}>
            <span className={styles.warningRule}>{t(`rule.${KNOWN_RULES.has(w.rule) ? w.rule : 'other'}` as 'rule.other')}</span>
            <q className={styles.quote}>{w.evidence}</q>
          </li>
        ))}
      </ul>
    </div>
  );
}
