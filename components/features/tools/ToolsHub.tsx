'use client';

// /tools — the free tools hub (WP-57; PRODUCT_PLAN.md F-TOOL-01). Only tools
// that work are listed. GoApply leads with the resume check (简历体检) and
// links the campus recruiting calendar when that capability is on (R-14; a
// disabled feature has no entry). Where the tools are off (GoApply CN-0: the
// page passes `toolsOpen={false}`, and /config says `available: false`) the
// tool entries are absent.
//
// "Job alerts by email" (/tools/job-alerts, WP-78) is listed last, only while
// job alerts and email are both on for this brand — the two capabilities the
// alerts form itself needs. It does not depend on the upload tools being open.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import { useCapabilities, useFlag } from '../../../lib/flags';
import { PageHeader } from '../../v3/primitives';
import { JOB_ALERTS_ENTRY, TOOLS, toolHref } from './catalog';
import { useToolsConfig } from './hooks';
import styles from './tools.module.css';

interface Card {
  id: string;
  href: string;
  title: string;
  body: string;
}

export interface ToolsHubProps {
  /** Whether the tools run for this brand and stage (server-side decision of the page). */
  toolsOpen?: boolean;
}

export function ToolsHub({ toolsOpen = true }: ToolsHubProps) {
  const t = useTranslations('tools');
  const brand = useBrand();
  const campus = useFlag('jobs.campusCalendar');
  const { flags } = useCapabilities();
  // Unresolved capabilities count as off (R-04: fail closed).
  const alertsOn = JOB_ALERTS_ENTRY.flags.every((f) => flags?.[f] === true);
  const config = useToolsConfig();
  const open = toolsOpen && config.data?.available !== false;
  // The allowance is shown only once the server has said what it is (RATE_LIMITS_JSON may change it).
  const limit = open ? (config.data?.perIpPerDay ?? null) : null;

  const cards: Card[] = (open ? TOOLS : []).map((tool) => ({
    id: tool.slug,
    href: toolHref(tool),
    title: t(`hub.${tool.key}.title`),
    body: t(`hub.${tool.key}.body`),
  }));
  if (brand.market === 'cn' && campus) {
    cards.splice(Math.min(1, cards.length), 0, {
      id: 'campus',
      href: '/campus',
      title: t('hub.campus.title'),
      body: t('hub.campus.body'),
    });
  }
  if (alertsOn) {
    cards.push({
      id: JOB_ALERTS_ENTRY.id,
      href: JOB_ALERTS_ENTRY.href,
      title: t(`hub.${JOB_ALERTS_ENTRY.key}.title`),
      body: t(`hub.${JOB_ALERTS_ENTRY.key}.body`),
    });
  }

  return (
    <div className={styles.page} data-tools-hub={brand.id}>
      <div className={styles.intro}>
        <PageHeader eyebrow={t('hub.eyebrow')} title={t('hub.title')} sub={limit === null ? t('hub.subNoLimit') : t('hub.sub', { limit })} />
      </div>
      {!open ? (
        <p className={styles.notice} role="status" data-notice="unavailable">
          {t('unavailable')}
        </p>
      ) : null}
      {cards.length ? (
        <ul className={styles.toolGrid} aria-label={t('hub.listLabel')}>
          {cards.map((card) => (
            <li key={card.id}>
              <Link href={card.href} className={styles.toolCard} data-tool-card={card.id}>
                <h2 className={styles.toolTitle}>{card.title}</h2>
                <p className={styles.body}>{card.body}</p>
                <span className={styles.toolOpen} aria-hidden="true">
                  {t('hub.open')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <p className={styles.muted} data-honesty="automated">
          {t('hub.honesty')}
        </p>
      ) : null}
    </div>
  );
}
