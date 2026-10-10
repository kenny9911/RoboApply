'use client';

// ImportWarnings — lines of a job post that are common in scams, quoted from
// the post itself (WP-35; rule-based signals and GoApply fraud rules from the
// market hooks, WP-41). Shown before and after saving, and when an add is
// reopened (`ImportStatusResponse.warnings`). Never a verdict: it says what
// the post says and asks the user to look carefully.
//
// A rule id we have copy for gets its own label: the three international
// rules here, GoApply's under `jobsCn.rules.*` (the same labels the review
// queue uses). Anything else reads "Flagged for a closer look".

import { useTranslations } from 'next-intl';

import type { ImportWarning } from '../../../lib/api/contracts/jobs/import';
import styles from './JobImport.module.css';

const KNOWN_RULES = new Set(['intl_pay_to_apply', 'intl_fee_required', 'intl_messaging_app_only']);
/** GoApply warning-sign rules with a label (server: CN_FRAUD_RULES, minus the catch-all `other`). */
const CN_RULES = new Set(['training_to_hire', 'training_loan', 'upfront_fee', 'mlm', 'gambling', 'telecom_lure', 'blacklisted_employer']);

export function ImportWarnings({ warnings }: { warnings: readonly ImportWarning[] }) {
  const t = useTranslations('jobImport.warnings');
  const tCn = useTranslations('jobsCn.rules');
  if (!warnings.length) return null;
  const label = (rule: string) =>
    CN_RULES.has(rule) ? tCn(rule as 'upfront_fee') : t(`rule.${KNOWN_RULES.has(rule) ? rule : 'other'}` as 'rule.other');
  return (
    <div className={styles.warnings} role="note" data-testid="import-warnings">
      <p className={styles.warningsTitle}>{t('title')}</p>
      <p className={styles.meta}>{t('intro')}</p>
      <ul className={styles.warningList}>
        {warnings.map((w) => (
          <li key={`${w.rule}:${w.evidence}`}>
            <span className={styles.warningRule}>{label(w.rule)}</span>
            <q className={styles.quote}>{w.evidence}</q>
          </li>
        ))}
      </ul>
    </div>
  );
}
