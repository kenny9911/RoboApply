'use client';

// EventCard — one campus programme (WP-58): company, programme, 届别, the 网申
// window in Beijing time as the official page states it ("Not listed" when it
// doesn't), stages, cities, roles, and always the provenance line "来源：…
// · 官网链接 · 最后核实 {date}" (+ "待核实" after 14 days). When the details
// were read from another page (sourceUrl), the source name links to it. Actions: "Apply on
// company site" (opens the official page; D1 — we never apply) and the
// 截止提醒 deadline reminder, wrapped in WP-73's SubscribeOnTap. Inside WeChat
// the tap also shows WeChat's one-time subscribe prompt for this programme;
// when the person accepts it the reminder is saved as a WeChat reminder
// (channel 'wechat': the last reminder also arrives in WeChat), otherwise as
// an inbox reminder.

import { useRef } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { Tag } from '../../v3/primitives/Tag';
import { SubscribeOnTap } from '../notify-cn';
import type { CampusEventView } from '../../../lib/api/contracts/cn/campus';
import { CAMPUS_TIME_ZONE, companyHref, hostOf, safeExternal, windowState, yearOfClass } from './format';
import styles from './campus.module.css';

/** Where a deadline reminder goes besides the inbox (the inbox row is always written). */
export type ReminderChannel = 'in_app' | 'wechat';

export interface ReminderState {
  /** Session known and signed in. */
  signedIn: boolean;
  /** Subscription id when the user has a reminder for this programme. */
  subscriptionId: string | null;
  pending: boolean;
  error: boolean;
  /** `channel` is 'wechat' when the person accepted WeChat's prompt at this tap; default the inbox. */
  onSubscribe: (eventId: string, channel?: ReminderChannel) => void;
  onUnsubscribe: (subscriptionId: string) => void;
  /** Where sign-in returns to. */
  returnTo: string;
}

export interface EventCardProps {
  event: CampusEventView;
  reminder: ReminderState;
  /** Hide the company link (on the company's own page). */
  hideCompanyLink?: boolean;
  /** "Now" for the window state (tests). */
  now?: Date;
}

export function useCampusDates() {
  const format = useFormatter();
  const parse = (iso: string | null | undefined) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  return {
    day(iso: string | null | undefined): string | null {
      const d = parse(iso);
      return d ? format.dateTime(d, { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric' }) : null;
    },
    moment(iso: string | null | undefined): string | null {
      const d = parse(iso);
      return d
        ? format.dateTime(d, { timeZone: CAMPUS_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        : null;
    },
  };
}

export function EventCard({ event, reminder, hideCompanyLink = false, now = new Date() }: EventCardProps) {
  const t = useTranslations('campus.event');
  const dates = useCampusDates();
  const state = windowState(event, now);
  const opens = dates.day(event.applyOpensAt);
  const closes = dates.moment(event.applyClosesAt);
  const official = safeExternal(event.officialUrl);
  // Where the details were read when that is not the official page: the source name links there.
  const cited = safeExternal(event.sourceUrl);
  const year = yearOfClass(event.graduationClass);
  const idBase = `campus-ev-${event.id}`;

  const windowLine = closes && opens ? t('window', { opens, closes }) : closes ? t('closes', { date: closes }) : opens ? t('opens', { date: opens }) : t('noClose');

  return (
    <article className={styles.card} aria-labelledby={`${idBase}-h`} data-campus-event={event.id}>
      <header className={styles.cardHead}>
        {hideCompanyLink ? (
          <span className={styles.company}>{event.companyName}</span>
        ) : (
          <Link className={styles.company} href={companyHref(event.companySlug)} aria-label={t('companyLink', { company: event.companyName })}>
            {event.companyName}
          </Link>
        )}
        <h3 className={styles.h3} id={`${idBase}-h`}>
          {event.title}
        </h3>
        <div className={styles.tags}>
          <Tag>{year ? t('classTag', { year }) : event.graduationClass}</Tag>
          <Tag>{t(`kind.${event.kind}`)}</Tag>
          {state === 'open' ? <Tag tone="strong">{t('openNow')}</Tag> : null}
          {state === 'not_yet' ? <Tag>{t('notYetOpen')}</Tag> : null}
          {state === 'closed' ? <Tag tone="warn">{t('closed')}</Tag> : null}
        </div>
      </header>

      <p className={styles.window}>
        {windowLine}
        {closes || opens ? <span className={styles.tz}> · {t('timeZone')}</span> : null}
      </p>

      {event.stages.length ? (
        <div>
          <p className={styles.muted}>{t('stagesTitle')}</p>
          <ul className={styles.stages}>
            {event.stages.map((s, i) => {
              const start = dates.day(s.startsAt);
              const end = dates.day(s.endsAt);
              const when = start && end ? t('stageRange', { start, end }) : start ? t('stageFrom', { date: start }) : end ? t('stageUntil', { date: end }) : t('stageNoDate');
              return (
                <li key={`${s.kind}-${i}`}>
                  <span className={styles.stageName}>{t(`stage.${s.kind}`)}</span> · {when}
                  {s.note ? ` · ${s.note}` : ''}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <dl className={styles.facts}>
        <dt>{t('cities')}</dt>
        <dd>{event.cities.length ? event.cities.join('、') : t('notListed')}</dd>
        <dt>{t('roles')}</dt>
        <dd>{event.roles.length ? event.roles.join('、') : t('notListed')}</dd>
      </dl>

      <p className={styles.provenance} data-provenance="">
        {cited ? (
          <span>
            {t.rich('sourceLinked', {
              source: event.sourceName ?? hostOf(cited),
              link: (chunks) => (
                <a className={styles.link} href={cited} target="_blank" rel="noopener noreferrer" aria-label={t('sourceAria', { source: event.sourceName ?? hostOf(cited) })}>
                  {chunks}
                </a>
              ),
            })}
          </span>
        ) : (
          <span>{t('source', { source: event.sourceName ?? hostOf(event.officialUrl) })}</span>
        )}
        {official ? (
          <>
            <span aria-hidden="true">·</span>
            <a className={styles.link} href={official} target="_blank" rel="noopener noreferrer" aria-label={t('officialPageAria', { company: event.companyName })}>
              {t('officialPage')}
            </a>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <span>{t('verified', { date: dates.day(event.verifiedAt) ?? '—' })}</span>
        {event.needsReverify ? (
          <span className={styles.reverify} title={t('needsCheckHint')}>
            {t('needsCheck')}
          </span>
        ) : null}
      </p>
      {event.needsReverify ? <p className={styles.hint}>{t('needsCheckHint')}</p> : null}

      <div className={styles.actions}>
        {official && state !== 'closed' ? (
          <Btn as="a" variant="primary" href={official} target="_blank" rel="noopener noreferrer" aria-label={t('applyAria', { company: event.companyName })}>
            {t('apply')}
          </Btn>
        ) : null}
        <ReminderButton event={event} state={state} reminder={reminder} />
      </div>
    </article>
  );
}

function ReminderButton({ event, state, reminder }: { event: CampusEventView; state: ReturnType<typeof windowState>; reminder: ReminderState }) {
  const t = useTranslations('campus.remind');
  // WeChat's answer at this tap; SubscribeOnTap reports it right before the button's own click.
  const wechatAccepted = useRef(false);
  if (state === 'closed') return null;
  if (!event.applyClosesAt) return <p className={styles.hint}>{t('noDate')}</p>;
  if (!reminder.signedIn) {
    return (
      <Btn as="a" href={`/login?from=campus&next=${encodeURIComponent(reminder.returnTo)}`}>
        {t('signIn')}
      </Btn>
    );
  }
  const on = Boolean(reminder.subscriptionId);
  return (
    <div className={styles.cardHead}>
      {on ? (
        <Btn aria-pressed="true" disabled={reminder.pending} onClick={() => reminder.onUnsubscribe(reminder.subscriptionId!)} title={t('off')}>
          {reminder.pending ? t('saving') : t('on')}
        </Btn>
      ) : (
        <SubscribeOnTap
          template="deadline_reminder"
          eventId={event.id}
          onAnswer={(answer) => {
            wechatAccepted.current = answer.accepted;
          }}
        >
          <Btn
            aria-pressed="false"
            disabled={reminder.pending}
            onClick={() => {
              const channel: ReminderChannel = wechatAccepted.current ? 'wechat' : 'in_app';
              wechatAccepted.current = false;
              reminder.onSubscribe(event.id, channel);
            }}
          >
            {reminder.pending ? t('saving') : t('set')}
          </Btn>
        </SubscribeOnTap>
      )}
      <p className={styles.hint}>{t('hint')}</p>
      {reminder.error ? (
        <p className={styles.error} role="alert">
          {t('error')}
        </p>
      ) : null}
    </div>
  );
}
