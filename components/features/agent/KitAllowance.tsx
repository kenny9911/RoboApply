'use client';

// KitAllowance — how many kits this plan prepares a week and how many are
// left (credit bucket `ready_kits`, weekly; PRODUCT F-AGENT-01, §6.2: Free 3
// a week, Pro up to 30). Every number is the server's (`/credits`):
//   - "N of M kits left this week": the week's allowance left against the
//     plan's weekly cap (never mixed with bonus credits);
//   - bonus kits, on their own line, when the user has any;
//   - "Pro: up to N a week" only when a sellable plan raises the cap and the
//     server sends that cap (`proCap`, requested from the credits owner);
//     until then only "See Pro". Unknown renders "—".

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { BILLING_PLANS_HREF } from '../credits';
import { bucketSummary, useCredits } from '../../../hooks/shared/useCredits';
import { proCapOf } from '../../../hooks/agent';
import styles from './ready.module.css';

export function KitAllowance() {
  const t = useTranslations('ready');
  const format = useFormatter();
  const { data } = useCredits();
  const summary = bucketSummary(data?.summary, 'ready_kits');
  const upgradable = data?.summary.upgradable === true;

  if (!summary || !Number.isFinite(summary.remaining) || !Number.isFinite(summary.cap)) {
    return (
      <p className={styles.muted} data-testid="kit-allowance">
        {t('allowance.unknown')}
      </p>
    );
  }
  const left = Math.min(Math.max(0, summary.remaining), Math.max(0, summary.cap));
  const bonus = Math.max(0, summary.grantRemaining ?? 0);
  const proCap = proCapOf(summary);
  const resets = new Date(summary.resetsAt);
  const date = Number.isNaN(resets.getTime()) ? null : format.dateTime(resets, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className={styles.stackTight} data-testid="kit-allowance" data-left={left}>
      <p className={styles.muted}>
        {t('allowance.left', { left, cap: summary.cap })}
        {date ? ` ${t('allowance.resets', { date })}` : null}
      </p>
      {bonus > 0 ? <p className={styles.muted}>{t('allowance.bonus', { count: bonus })}</p> : null}
      {upgradable ? (
        <p className={styles.muted}>
          {proCap !== null && proCap > summary.cap ? `${t('allowance.pro', { count: proCap })} ` : null}
          <Link href={BILLING_PLANS_HREF} className={styles.linkButton}>
            {t('allowance.seePro')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
