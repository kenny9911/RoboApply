'use client';

// TopbarCtas — the two calls to action resume.io keeps in its app header
// (docs/resume-io/TEARDOWN.md), drawn with RoboApply's own features:
//
//   ReadyLink    a two-line link to /ready ("Ready to apply" over the number
//                of prepared applications not yet opened, or "See what's
//                ready"), with an arrow tile. Where resume.io sells Auto
//                Apply, RoboApply prepares applications and the user submits
//                them (ruling R1), so the wording never claims a submission.
//                Shown with the `agent` capability, like the Ready nav entry.
//   UpgradeLink  "Upgrade" on the plan colour, for a free account only, to
//                /settings#billing (the plan page PlanBadge also opens). It
//                renders nothing until the entitlement summary is known.
//
// Both hide below 760px (shell.module.css): the phone header has no room, and
// the same places are one tap away in the More sheet.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useFlag } from '../../../lib/flags';
import { useCredits } from '../../../hooks/shared/useCredits';
import { useReadyBadge } from '../../../hooks/agent/useReadyBadge';
import { IconArrow, IconBolt } from '../primitives/Iconset';
import styles from './shell.module.css';

export function ReadyLink() {
  const t = useTranslations('nav.topbar');
  const tn = useTranslations('nav');
  const on = useFlag('agent');
  const badge = useReadyBadge();
  if (!on) return null;
  const count = badge && badge.kind === 'count' ? badge.count : 0;
  return (
    <Link href="/ready" className={styles.readyLink}>
      <span className={styles.readyCopy}>
        <strong>{tn('ready')}</strong>
        <span>{count > 0 ? t('ready_count', { count }) : t('ready_open')}</span>
      </span>
      <span className={styles.readyArrow} aria-hidden="true">
        <IconArrow size={16} />
      </span>
    </Link>
  );
}

export function UpgradeLink() {
  const t = useTranslations('nav.topbar');
  const { data } = useCredits();
  const summary = data?.summary;
  if (!summary || summary.legacyPlan || summary.planProfile === 'pro') return null;
  return (
    <Link href="/settings#billing" className={styles.upgrade}>
      <IconBolt size={14} />
      <span>{t('upgrade')}</span>
    </Link>
  );
}
