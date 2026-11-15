'use client';

// Small shared pieces of /today: the lane frame, the "—" of a number that is
// not loaded, and the plain "this did not load" note with its retry.

import { useId, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, Tag } from '../../v3/primitives';
import styles from './today.module.css';

export interface LaneProps {
  /** Anchor id (the empty "Waiting for you" line points at the picks). */
  id?: string;
  /** The lane's job: "Job search", "Applications", "Resume". Never a persona (ruling C9). */
  title: string;
  /** The lane is an agent's work: carries the small "Agent" tag. */
  agent?: boolean;
  busy?: boolean;
  children: ReactNode;
  testId?: string;
}

export function Lane({ id, title, agent = false, busy = false, children, testId }: LaneProps) {
  const t = useTranslations('today');
  const titleId = useId();
  return (
    <section id={id} className={styles.lane} aria-labelledby={titleId} aria-busy={busy || undefined} data-testid={testId}>
      <div className={styles.laneHead}>
        <h2 id={titleId} className={styles.laneTitle}>
          {title}
        </h2>
        {agent ? <Tag>{t('agentTag')}</Tag> : null}
      </div>
      {children}
    </section>
  );
}

/** A value that is not loaded: "—", never 0 (ruling D3). */
export function Unknown() {
  const t = useTranslations('today');
  return (
    <span className={styles.unknown} data-unknown="true">
      <span aria-hidden="true">—</span>
      <span className={styles.srOnly}>{t('notLoaded')}</span>
    </span>
  );
}

/** A number, or "—" while it is not known. */
export function Count({ value }: { value: number | null }) {
  return value === null ? <Unknown /> : <>{value}</>;
}

export interface FailedNoteProps {
  message: string;
  onRetry: () => void;
}

/** A read failed: one plain line and "Try again". It never blocks the rest of the page. */
export function FailedNote({ message, onRetry }: FailedNoteProps) {
  const t = useTranslations('today');
  return (
    <div className={styles.failed} role="status" data-testid="today-failed">
      <p>{message}</p>
      <Btn onClick={onRetry}>{t('retry')}</Btn>
    </div>
  );
}
