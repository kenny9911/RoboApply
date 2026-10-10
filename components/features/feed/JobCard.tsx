'use client';

// components/features/feed/JobCard.tsx — one job in the feed (PRODUCT
// F-FEED-05/06/07, R2, C38, C41; D1, D3).
//
// Order on the card (ruling R2: the card leads with the gap, not the score):
//   4 px fit strip along the top edge (C41)
//   gap line · overlap line                    corner: tier + "87 / 100"
//   "This is not your chance of getting hired." (under every score)
//   one past-tense line about the work done (C38)
//   logo · company · title (link) · location · work model · type · level · pay
//   posted · last checked · source line · ≤3 badges · market slot
//   Save for later · Apply on company site · Ask about this job · …
//
// D1: "Apply on company site" opens the employer's page; the user submits
// there. The job moves to Applied at once with an inline Undo (R-19).
// D3: unknown pay is "Pay not listed", unknown score "—", nothing invented.

import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Btn, FitTierLabel, HonestyLine, toast } from '../../v3/primitives';
import { normalizeScore, type FitTierKey } from '../common';
import { MarketJobMeta } from '../market';
import { WhyThisJob } from '../compliance';
import { useJobActions } from '../../../hooks/shared/useJobActions';
import { useFlag } from '../../../lib/flags';
import { track } from '../../../lib/analytics';
import type { FeedItem } from '../../../lib/api/contracts/feed';
import { cardBadges, companyInitial, itemExtras, payText, shortDate, sourceLine, type CardBadge } from './cardModel';
import { NotInterestedSheet } from './NotInterestedSheet';
import { ReportSheet } from './ReportSheet';
import styles from './feed.module.css';

export interface JobCardProps {
  item: FeedItem;
  /** Position in the list (0-based), for telemetry. */
  position: number;
  market: 'intl' | 'cn';
  /** The job shown in the split detail. */
  active?: boolean;
  /**
   * Open the job. Return true when the caller handled it (desktop split view);
   * otherwise the title link navigates to /jobs/[id].
   */
  onOpen?: (jobId: string) => boolean;
  /** The server hid the job (Not interested / report): remove the card. */
  onHidden?: (jobId: string) => void;
  /** Impression ref from useImpressions. */
  observe?: (node: Element | null) => void;
}

const SAVED_STATUSES = new Set(['bookmarked', 'saved']);
const APPLIED_STATUSES = new Set(['applied', 'interviewing', 'interview', 'offer', 'screen', 'phone_screen']);

function BadgeView({ badge, locale }: { badge: CardBadge; locale: string }) {
  const t = useTranslations('jobs.card.badge');
  const tipId = useId();
  switch (badge.kind) {
    case 'direct':
      return <span className={`${styles.badge} ${styles.badgeDirect}`}>{t('direct')}</span>;
    case 'agency':
      return <span className={styles.badge}>{t('agency')}</span>;
    case 'new':
      return <span className={styles.badge}>{t('new')}</span>;
    case 'market':
      return <span className={styles.badge}>{badge.label}</span>;
    case 'closes': {
      const date = shortDate(badge.at, locale);
      return date ? <span className={styles.badge}>{t('closes', { date })}</span> : null;
    }
    case 'sponsorship':
      return (
        <span className={styles.badge} title={t('sponsorshipQuote', { quote: badge.quote })} aria-describedby={tipId}>
          {badge.status === 'not_offered' ? t('sponsorshipNo') : t('sponsorship')}
          <span id={tipId} className="sr-only">
            {t('sponsorshipQuote', { quote: badge.quote })}
          </span>
        </span>
      );
  }
}

export function JobCard({ item, position, market, active = false, onOpen, onHidden, observe }: JobCardProps) {
  const t = useTranslations('jobs.card');
  const tScore = useTranslations('jobs.score');
  const tOpt = useTranslations('filters.options');
  const locale = useLocale();
  const copilotOn = useFlag('copilot');
  const actions = useJobActions(item.jobId, { source: 'job_card' });
  const status = item.tracker?.status ?? null;
  const [saved, setSaved] = useState(status ? SAVED_STATUSES.has(status) : false);
  const [appliedNote, setAppliedNote] = useState<'apply' | 'mark' | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<'hide' | 'report' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const score = normalizeScore(item.fit?.score);
  const tier = (item.fit?.tier ?? null) as FitTierKey | null;
  const badges = cardBadges(item);
  const source = sourceLine(item);
  const extras = itemExtras(item);
  const pay = payText(item.pay, {
    locale,
    market,
    range: (min, max) => t('payRange', { min, max }),
    from: (amount) => t('payFrom', { amount }),
    upTo: (amount) => t('payUpTo', { amount }),
  });
  const posted = shortDate(item.postedAt, locale);
  const checked = shortDate(item.lastSeenAt, locale);
  const alreadyApplied = status ? APPLIED_STATUSES.has(status) : false;

  // Close the … menu on Escape and on a click outside it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onClick = (e: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  const label = (group: 'jobTypes' | 'seniority' | 'workModels', value: string | null) => {
    if (!value) return null;
    const key = `${group}.${value}`;
    return tOpt.has(key) ? tOpt(key) : null;
  };
  const facts = [
    item.location,
    label('workModels', item.workModel),
    label('jobTypes', item.employmentType),
    label('seniority', item.seniority),
  ].filter((v): v is string => !!v);

  const onTitleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    track('job_opened', { jobId: item.jobId, from: 'feed', position });
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (onOpen?.(item.jobId)) e.preventDefault();
  };

  // useJobActions keeps failures in `actions.error`; revert the optimistic
  // change of the action that failed and say so. Hide and share say it in
  // their own words (the sheet's inline error, the share toast), so only the
  // card's own actions toast here: one message per failure.
  type CardOp = 'save' | 'unsave' | 'mark' | 'apply' | 'undo' | 'hide' | 'share';
  const lastOp = useRef<CardOp | null>(null);
  const handledError = useRef<unknown>(null);
  useEffect(() => {
    if (!actions.error || handledError.current === actions.error) return;
    handledError.current = actions.error;
    const op = lastOp.current;
    lastOp.current = null;
    if (op === 'save') setSaved(false);
    else if (op === 'unsave') setSaved(true);
    if (op === 'hide' || op === 'share' || op === null) return;
    toast({ message: t('actions.failed'), tone: 'warn' });
  }, [actions.error, t]);

  // The Applied line follows useJobActions' own state: `lastApplied` is set
  // only by a successful apply / "Already applied" and cleared only by a
  // successful undo. A failed undo keeps the line (and its Undo) on screen.
  const lastApplied = actions.lastApplied;
  const prevApplied = useRef(lastApplied);
  useEffect(() => {
    const was = prevApplied.current;
    prevApplied.current = lastApplied;
    if (was !== null && lastApplied === null) {
      setAppliedNote(null);
      toast({ message: t('actions.undone'), tone: 'info' });
    }
  }, [lastApplied, t]);

  const toggleSave = async () => {
    if (saved) {
      lastOp.current = 'unsave';
      setSaved(false);
      await actions.unsave();
      return;
    }
    lastOp.current = 'save';
    setSaved(true);
    track('job_saved', { jobId: item.jobId, from: 'feed' });
    await actions.save();
  };

  const apply = async () => {
    track('apply_clicked', { jobId: item.jobId, from: 'feed' });
    lastOp.current = 'apply';
    setAppliedNote('apply');
    await actions.applyOnCompanySite();
  };

  const markApplied = async () => {
    setMenuOpen(false);
    lastOp.current = 'mark';
    setAppliedNote('mark');
    await actions.markApplied();
  };

  const undo = async () => {
    lastOp.current = 'undo';
    await actions.undoApplied();
  };

  const hide: typeof actions.hide = (reason, detail) => {
    lastOp.current = 'hide';
    return actions.hide(reason, detail);
  };

  const share = async () => {
    setMenuOpen(false);
    lastOp.current = 'share';
    const res = await actions.share();
    if (!res?.url) {
      toast({ message: t('actions.shareFailed'), tone: 'warn' });
      return;
    }
    try {
      await navigator.clipboard.writeText(res.url);
      toast({ message: t('actions.shareCopied'), tone: 'ok' });
    } catch {
      toast({ message: res.url, tone: 'info', durationMs: 0 });
    }
  };

  // Optimistic while "Already applied" is being recorded; otherwise the hook's state.
  const showApplied = lastApplied !== null || actions.pending === 'markApplied';

  return (
    <article
      ref={observe}
      data-job-id={item.jobId}
      data-testid="job-card"
      aria-labelledby={titleId}
      className={`${styles.card}${active ? ` ${styles.cardActive}` : ''}`}
    >
      <div className={styles.strip} aria-hidden="true">
        {score !== null ? <span className={styles.stripFill} data-tier={tier ?? undefined} style={{ width: `${score}%` }} /> : null}
      </div>

      {item.fit ? (
        <div className={styles.cardTop}>
          <div className={styles.lead}>
            {item.fit.topGap ? (
              <p className={styles.gap}>
                <span className={styles.leadLabel}>{t('whatsMissing')}: </span>
                {item.fit.topGap}
              </p>
            ) : null}
            {item.fit.topOverlap ? (
              <p className={styles.overlap}>
                <span className={styles.leadLabel}>{t('whatLinesUp')}: </span>
                {item.fit.topOverlap}
              </p>
            ) : null}
          </div>
          <div className={styles.corner}>
            <FitTierLabel tier={tier} score={score} />
            <span className={styles.scoreNum}>{score === null ? '—' : tScore('unit', { score })}</span>
            {item.fit.kind === 'pre' ? <span className={styles.estimate}>{t('quickEstimate')}</span> : null}
          </div>
        </div>
      ) : null}
      {item.fit ? <HonestyLine kind="fit" className={styles.honesty} /> : null}
      {item.fit ? <p className={styles.workLine}>{item.fit.kind === 'ai' ? t('workAi') : t('workPre')}</p> : null}

      <div className={styles.identity}>
        {item.company.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- third-party logos; no remote image config for arbitrary hosts
          <img className={styles.logo} src={item.company.logoUrl} alt={t('companyLogo', { company: item.company.name })} loading="lazy" />
        ) : (
          <span className={styles.logo} aria-hidden="true">
            {companyInitial(item.company.name)}
          </span>
        )}
        <div className={styles.names}>
          <span className={styles.company}>{item.company.name}</span>
          <h3 className={styles.jobTitle} id={titleId}>
            <Link
              href={`/jobs/${encodeURIComponent(item.jobId)}`}
              className={styles.jobLink}
              onClick={onTitleClick}
              aria-label={t('openJob', { title: item.title, company: item.company.name })}
              aria-current={active ? 'true' : undefined}
            >
              {item.title}
            </Link>
          </h3>
        </div>
      </div>

      <ul className={styles.facts}>
        {facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
        <li className={pay ? styles.pay : styles.payUnknown} data-testid="pay">
          {pay ? (pay.period ? t(`payPeriod.${pay.period}`, { amount: pay.amount }) : pay.amount) : t('payNotListed')}
        </li>
      </ul>

      <div className={styles.meta}>
        <span>{posted ? t('posted', { date: posted }) : t('postedUnknown')}</span>
        {checked ? <span>{t('lastChecked', { date: checked })}</span> : null}
        {source ? (
          <span data-testid="source-line">
            {source.key === 'bank'
              ? t('source.bank', { sourceName: source.sourceName })
              : source.key === 'user_import'
                ? t('source.user_import')
                : t(`source.${source.key}`, { name: source.name })}
          </span>
        ) : null}
      </div>

      {badges.length > 0 ? (
        <ul className={styles.badges} aria-label={t('badges')}>
          {badges.map((b) => (
            <li key={b.kind === 'market' ? `market:${b.label}` : b.kind}>
              <BadgeView badge={b} locale={locale} />
            </li>
          ))}
        </ul>
      ) : null}

      <MarketJobMeta jobId={item.jobId} meta={extras.cardMeta} variant="card" />

      {extras.explanation && item.fit ? (
        <details className={styles.why}>
          <summary>{t('whyThisJob')}</summary>
          <WhyThisJob explanation={extras.explanation} />
        </details>
      ) : null}

      {showApplied ? (
        <p className={styles.inlineStatus} role="status">
          <span>{appliedNote === 'mark' ? t('actions.markedApplied') : t('actions.movedToApplied')}</span>
          <button type="button" className={styles.textBtn} onClick={() => void undo()} disabled={actions.pending === 'undoApplied'}>
            {t('actions.undoApplied')}
          </button>
        </p>
      ) : null}

      <div className={styles.actions} role="group" aria-label={t('actions.label', { title: item.title })}>
        <Btn className={styles.actionBtn} onClick={() => void toggleSave()} aria-pressed={saved} disabled={actions.pending === 'save' || actions.pending === 'unsave'}>
          {saved ? t('actions.saved') : t('actions.save')}
        </Btn>
        {!showApplied && !alreadyApplied ? (
          <Btn variant="primary" className={styles.actionBtn} onClick={() => void apply()} disabled={actions.pending === 'apply'}>
            {actions.pending === 'apply' ? t('actions.applyPending') : t('actions.apply')}
          </Btn>
        ) : null}
        {copilotOn ? (
          <Btn variant="ghost" className={styles.actionBtn} onClick={() => actions.askAboutJob()}>
            {t('actions.ask')}
          </Btn>
        ) : null}
        <div className={styles.menuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('actions.more')}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span aria-hidden="true">…</span>
          </button>
          {menuOpen ? (
            <ul className={styles.menu} role="menu">
              <li role="none">
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setMenuOpen(false); setSheet('hide'); }}>
                  {t('actions.notInterested')}
                </button>
              </li>
              {!alreadyApplied && !showApplied ? (
                <li role="none">
                  <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void markApplied()}>
                    {t('actions.alreadyApplied')}
                  </button>
                </li>
              ) : null}
              <li role="none">
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => { setMenuOpen(false); setSheet('report'); }}>
                  {t('actions.report')}
                </button>
              </li>
              <li role="none">
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void share()}>
                  {t('actions.share')}
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      </div>

      <NotInterestedSheet
        open={sheet === 'hide'}
        job={item}
        market={market}
        onClose={() => setSheet(null)}
        hide={hide}
        onHidden={() => onHidden?.(item.jobId)}
      />
      <ReportSheet
        open={sheet === 'report'}
        job={item}
        market={market}
        onClose={() => setSheet(null)}
        onReported={() => onHidden?.(item.jobId)}
      />
    </article>
  );
}
