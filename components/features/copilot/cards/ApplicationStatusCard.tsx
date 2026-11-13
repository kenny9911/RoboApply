'use client';

// application_status — where one application stands on the user's list
// (docs/agent-driven/REDESIGN.md §1, §9). It is the result of an applied
// list_add / prepare_application card, and what those tools answer for a job
// that is already on the list.
//
// It links to the application the way the "Prepare application" button does
// (`placeOf` with `kitHref` / `applicationHref`): the application's page
// `/ready/<jobId>` while it is on the list, Applications once it was opened.
// It names the list state with the list's own words, and says the user
// submits each application themselves (D1): nothing here opens or sends one.

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { HonestyLine, Pill } from '../../../v3/primitives';
import { STATE_TONE, applicationHref, kitHref, placeOf } from '../../agent';
import { CardFrame } from './CardFrame';
import { jobLine, parseApplicationStatus, type ApplicationStatusData } from './model';
import type { CardContext, CardProps } from './types';
import styles from '../copilot.module.css';

export type ApplicationLinkLabel = 'review' | 'sent' | 'open';

/** Where the card links for this state, as the "Prepare application" button would. Pure. */
export function applicationLink(data: Pick<ApplicationStatusData, 'jobId' | 'state' | 'trackerEntryId'>): { href: string; label: ApplicationLinkLabel } {
  switch (placeOf(data.state)) {
    case 'sent':
      return { href: applicationHref(data.trackerEntryId), label: 'sent' };
    case 'review':
      return { href: kitHref(data.jobId), label: 'review' };
    case 'listed':
      return { href: '/ready?tab=done', label: 'open' };
    default:
      // On the list and not prepared yet, or being prepared: the application's own page.
      return { href: kitHref(data.jobId), label: 'open' };
  }
}

/** The state, what happens next, the link, and who submits. Shared with the proposal cards once applied. */
export function ApplicationStatusBody({ data, ctx }: { data: ApplicationStatusData; ctx: CardContext }) {
  const t = useTranslations('assistant.cards.applicationStatus');
  const ready = useTranslations('ready');
  const link = applicationLink(data);
  const next = data.state === 'preparing' ? ready('oneTap.started') : data.state === 'picked' ? t('picked') : null;
  const label = link.label === 'review' ? ready('oneTap.place.review') : link.label === 'sent' ? ready('oneTap.place.sent') : t('open');
  return (
    <div className={styles.statusBody} data-testid="application-status" data-state={data.state}>
      <p className={styles.cardText}>
        <Pill tone={STATE_TONE[data.state]}>{ready(`state.${data.state}`)}</Pill>
      </p>
      {next ? <p className={styles.cardText}>{next}</p> : null}
      <Link href={link.href} className={styles.link} onClick={ctx.onNavigate}>
        {label}
      </Link>
      <HonestyLine kind="you_submit" />
    </div>
  );
}

export function ApplicationStatusCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards');
  const data = parseApplicationStatus(card.data);
  if (!data) return null;
  const job = jobLine(data.jobTitle, data.company) ?? t('credit.jobFallback');
  return (
    <CardFrame card={card} title={t('applicationStatus.title', { job })}>
      <ApplicationStatusBody data={data} ctx={ctx} />
    </CardFrame>
  );
}
