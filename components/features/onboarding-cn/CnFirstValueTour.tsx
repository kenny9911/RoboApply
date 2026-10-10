'use client';

// GoApply first value (stage `tour`; PRODUCT_PLAN.md §4.5 G7): one prompt,
// "开启网申截止提醒", then a 3-card tour (校招日历 · 定制简历 · AI面试练习).
// Cards for features that are off for this user are not shown (R-04; AI
// features need the AI processing consent).
//
// The reminder prompt lists the programmes open now for the user's 届别 and
// subscribes only to the ones the user ticks (in-app inbox; WeChat and email
// channels come with WP-58/WP-73). Nothing is subscribed silently. Rendered by
// the first-value screen (WP-30 tour slot on /jobs, or /campus, WP-58);
// `onFinish` moves the stage to `done`.

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { CampusEventView } from '../../../lib/api/contracts/cn/campus';
import { Btn } from '../../v3/primitives/Btn';
import { useCnOnboardingApi } from './api';
import styles from './OnboardingCn.module.css';

export interface CnFirstValueTourProps {
  /** 届别 from the identity step (programmes for it are listed). */
  classYear?: number | null;
  /** The chosen cities (不限 or none = all cities). */
  cities?: readonly string[];
  /** The campus calendar is on (R-04: off = no reminder prompt and no calendar card). */
  campusCalendar: boolean;
  /** The user's AI processing consent is on (and, on GoApply, `aiAllowed()`). Off = no AI features are advertised. */
  aiAllowed: boolean;
  /** Tour finished or dismissed. */
  onFinish: () => void;
}

export type CnTourCard = 'calendar' | 'tailor' | 'practice' | 'manual';

/**
 * Only features this user can use now are shown: the calendar only when it
 * is on; 定制简历 and AI面试练习 only with AI consent. Without it, one card
 * says how to fill the profile by hand and where to turn AI on.
 */
export function tourCards(caps: { campusCalendar: boolean; aiAllowed: boolean }): CnTourCard[] {
  return [...(caps.campusCalendar ? (['calendar'] as const) : []), ...(caps.aiAllowed ? (['tailor', 'practice'] as const) : (['manual'] as const))];
}

export function CnFirstValueTour({ classYear, cities, campusCalendar, aiAllowed, onFinish }: CnFirstValueTourProps) {
  const t = useTranslations('onboardingCn');
  const format = useFormatter();
  const api = useCnOnboardingApi();
  const [phase, setPhase] = useState<'reminders' | 'tour'>(campusCalendar ? 'reminders' : 'tour');
  const [programs, setPrograms] = useState<CampusEventView[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: number; failed: boolean } | null>(null);

  useEffect(() => {
    if (phase !== 'reminders') return;
    let live = true;
    api
      .campusPrograms({ classYear, cities })
      .then((p) => live && setPrograms((p?.items ?? []).filter((e) => !e.subscribed).slice(0, 6)))
      .catch(() => live && setPrograms([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, phase, classYear, (cities ?? []).join('|')]);

  async function subscribe() {
    setBusy(true);
    let ok = 0;
    let failed = false;
    for (const id of picked) {
      try {
        await api.subscribeProgram(id);
        ok++;
      } catch {
        failed = true;
      }
    }
    setBusy(false);
    setResult({ ok, failed });
  }

  if (phase === 'reminders') {
    return (
      <section className={styles.step} aria-labelledby="cn-reminders">
        <header className={styles.head}>
          <h2 id="cn-reminders" className={styles.title}>
            {t('tour.remindersTitle')}
          </h2>
          <p className={styles.subtitle}>{t('tour.remindersBody')}</p>
        </header>
        {programs === null ? (
          <p className={styles.note}>{t('common.loading')}</p>
        ) : programs.length === 0 ? (
          <p className={styles.note}>{t('tour.remindersNone')}</p>
        ) : (
          <ul className={styles.list}>
            {programs.map((p) => (
              <li key={p.id} className={styles.listItem}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    disabled={busy || result !== null}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                  />
                  <span>
                    <strong>{p.companyName}</strong> · {p.title}
                    <br />
                    <span className={styles.optionMeta}>
                      {t('confirm.closes', { date: p.applyClosesAt ? format.dateTime(new Date(p.applyClosesAt), { month: 'short', day: 'numeric' }) : '—' })}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {result ? (
          <p className={result.failed ? styles.error : styles.note} role="status">
            {result.failed ? t('tour.remindersFailed', { count: result.ok }) : t('tour.remindersDone', { count: result.ok })}
          </p>
        ) : null}
        <div className={styles.actions}>
          <div className={styles.actionsEnd}>
            {result ? (
              <Btn variant="primary" onClick={() => setPhase('tour')}>
                {t('common.next')}
              </Btn>
            ) : (
              <>
                <Btn onClick={() => setPhase('tour')} disabled={busy}>
                  {t('tour.notNow')}
                </Btn>
                <Btn variant="primary" onClick={() => void subscribe()} disabled={busy || picked.length === 0}>
                  {t('tour.remind')}
                </Btn>
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.step} aria-labelledby="cn-tour">
      <h2 id="cn-tour" className={styles.title}>
        {t('tour.title')}
      </h2>
      <div className={styles.tour}>
        {tourCards({ campusCalendar, aiAllowed }).map((c) => (
          <article key={c} className={styles.tourCard}>
            <h3 className={styles.label}>{t(`tour.card.${c}.title`)}</h3>
            <p className={styles.subtitle}>{t(`tour.card.${c}.body`)}</p>
          </article>
        ))}
      </div>
      <div className={styles.actions}>
        <div className={styles.actionsEnd}>
          <Btn variant="primary" onClick={onFinish}>
            {t('tour.start')}
          </Btn>
        </div>
      </div>
    </section>
  );
}
