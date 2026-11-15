'use client';

// TodayDesk — the agent desk, drawn from the reads it is handed
// (docs/agent-driven/REDESIGN.md §5). It asks for nothing itself: the
// Dashboard composes the reads (hooks/today) and tests hand it fixtures.
// The signed-in home is the resume.io-style Dashboard (/dashboard; /today
// redirects there), which draws this desk with `variant="dashboard"`; the
// order below is the `desk` variant's.
//
// Order on a phone; from 1100px the first two share the main column and the
// rest sit beside them:
//   header            today's date · "{n} things are waiting for you" · the goal line + Change
//   Waiting for you   at most four cards; the first carries the screen's one primary button
//                     (when nothing waits, the first pick's action carries it instead)
//   Job search        one past-tense line with a real count · three picks · See all jobs
//   Applications      real counts · the week's allowance · "You submit each application yourself."
//   Resume            the main resume and its latest check · what jobs ask for
//   Ask               one input that opens the Assistant (flag `copilot`)
//
// No persona (ruling C9): lanes are named by their job; nothing here says "I".

import { useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { PageHeader } from '../../v3/primitives';
import type { TodaySources } from '../../../hooks/today';
import { useBrand } from '../../../lib/brand/BrandProvider';
import type { CheckState } from '../resume';
import { ApplicationsLane } from './ApplicationsLane';
import { AskBox } from './AskBox';
import { GoalLine } from './GoalLine';
import { JobSearchLane, shownPicks } from './JobSearchLane';
import { ResumeLane } from './ResumeLane';
import { titleOf, waitingOf } from './todayModel';
import { WaitingList } from './WaitingList';
import styles from './today.module.css';

export interface DeskGoalsContext {
  /**
   * Nothing waits for the user (the list has answered), so the goals section's
   * call to action is the screen's one primary button. False while a waiting
   * card holds it, and while the waiting list is still loading.
   */
  leadPrimary: boolean;
}

export interface TodayDeskProps {
  sources: TodaySources;
  /** The main resume's latest check; null when there is no main resume (or the resumes are not loaded). */
  check: CheckState | null;
  /** "Now", for the date, the 10-day rule and "this week". Injectable for tests and previews. */
  now?: Date;
  /**
   * `desk` is the agent desk on its own (two columns from 1100px, the count as
   * the page title). `dashboard` is the same desk inside the resume.io-style
   * Dashboard (components/features/dashboard): one column, the Dashboard's own
   * greeting as the title with the count under it, the goals section between
   * "Waiting for you" and the lanes, the picks as cards, and no Ask box (the
   * Dashboard has its own ask bar).
   */
  variant?: 'desk' | 'dashboard';
  /** `dashboard`: the page title (the greeting, an h1). */
  greeting?: ReactNode;
  /** `dashboard`: the goals section, told whether it carries the primary button. */
  goals?: (ctx: DeskGoalsContext) => ReactNode;
}

export function TodayDesk({ sources, check, now: nowProp, variant = 'desk', greeting, goals }: TodayDeskProps) {
  const t = useTranslations('today');
  const format = useFormatter();
  const market = useBrand().market;
  const [openedAt] = useState(() => new Date());
  const now = nowProp ?? openedAt;

  const waiting = waitingOf(sources, now.getTime());
  const title = titleOf(waiting);
  const heading =
    title.kind === 'loading'
      ? t('header.titleLoading')
      : title.kind === 'count'
        ? t('header.title', { count: title.count })
        : title.kind === 'partial'
          ? t('header.titlePartial')
          : t('header.titleNone');
  // The empty "Waiting for you" line points at the picks only when there are picks on screen to point at.
  const picksBelow = sources.picks.status === 'ready' && shownPicks(sources.picks.data, market).length > 0;
  // One primary button on the screen, always: the first waiting card when something waits, else the first pick
  // (on the Dashboard: the goals section's call to action). Only once the waiting list has answered with nothing:
  // while it loads, a card may still be about to take it.
  const leadPrimary = waiting.status === 'ready' && waiting.shown.length === 0;

  if (variant === 'dashboard') {
    return (
      <div className={styles.dash} data-testid="today-desk" data-variant="dashboard">
        <header className={styles.dashHead}>
          {greeting}
          <p className={styles.dashStatus} data-testid="today-status">
            {heading}
          </p>
          <GoalLine search={sources.search} />
        </header>
        <WaitingList waiting={waiting} picksBelow={picksBelow} />
        {goals ? goals({ leadPrimary }) : null}
        <JobSearchLane flags={sources.flags} newJobs={sources.newJobs} picks={sources.picks} picksFrom={sources.picksFrom} leadPrimary={false} searching={sources.searching} />
        <div className={styles.dashLanes}>
          <ApplicationsLane flags={sources.flags} queue={sources.queue} board={sources.board} now={now} />
          <ResumeLane resumes={sources.resumes} check={check} skills={sources.skills} />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        // The server renders in the brand's time zone and the browser in the reader's: around midnight the two can
        // name different days. The reader's day is the right one, so a difference is not reported as an error.
        eyebrow={<span suppressHydrationWarning>{format.dateTime(now, { weekday: 'long', month: 'long', day: 'numeric' })}</span>}
        title={heading}
        sub={<GoalLine search={sources.search} />}
      />

      <div className={styles.desk} data-testid="today-desk">
        <div className={styles.column}>
          <WaitingList waiting={waiting} picksBelow={picksBelow} />
          <JobSearchLane
            flags={sources.flags}
            newJobs={sources.newJobs}
            picks={sources.picks}
            picksFrom={sources.picksFrom}
            leadPrimary={leadPrimary}
            searching={sources.searching}
          />
        </div>
        <div className={styles.column}>
          <ApplicationsLane flags={sources.flags} queue={sources.queue} board={sources.board} now={now} />
          <ResumeLane resumes={sources.resumes} check={check} skills={sources.skills} />
          {sources.flags.copilot ? <AskBox /> : null}
        </div>
      </div>
    </>
  );
}
