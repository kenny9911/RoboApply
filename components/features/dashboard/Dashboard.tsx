'use client';

// Dashboard — the signed-in home (/dashboard), laid out as resume.io's app
// dashboard (docs/resume-io/TEARDOWN.md, "The dashboard"):
//
//   "Hi {name}!" and a question, centred
//   four goal tabs joined by short rules (Resume · Job search · Applications ·
//   Interview prep)
//   the Progress card (the goal's steps, each a row with an icon tile, the
//   value and a bar) beside the hero card (the selected step: what it is,
//   one call to action and a picture of it)
//   "Your job matches" (JobMatches) and the floating ask bar (AskBar)
//
// The selection lives in the URL (`?goal=…&step=…`, like resume.io's
// `categoryTab` / `serviceId`), so a link can open a step and Back restores
// it. Every value comes from useDashboardFacts (real, or "not known yet");
// the model (model.ts) turns facts into meters. All copy is under the
// `dashboard` namespace.

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, type ComponentType } from 'react';

import { useAuth } from '../../../lib/auth/useAuth';
import { useFlag } from '../../../lib/flags';
import { ResumeThumb } from '../resume/hub/ResumeThumb';
import {
  IconArrow,
  IconCalendar,
  IconCheck,
  IconEdit,
  IconFile,
  IconMic,
  IconPerson,
  IconSearch,
  IconStack,
  IconTarget,
  type IconProps,
} from '../../v3/primitives/Iconset';
import {
  GOALS,
  STRONG_SCORE,
  goalSteps,
  heroState,
  selectionFrom,
  stepHref,
  type DashboardFacts,
  type GoalId,
  type HiddenSteps,
  type StepId,
  type StepProgress,
} from './model';
import { useDashboardFacts } from './useDashboardFacts';
import { JobMatches } from './JobMatches';
import { AskBar } from './AskBar';
import styles from './dashboard.module.css';

const STEP_ICONS: Record<StepId, ComponentType<IconProps>> = {
  resume_check: IconFile,
  tailored: IconTarget,
  letters: IconEdit,
  profile: IconPerson,
  saved: IconSearch,
  preparing: IconCheck,
  applied: IconStack,
  interviews: IconCalendar,
  practice: IconMic,
};

/** The first word of the name, for the greeting. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

export function Dashboard() {
  const t = useTranslations('dashboard');
  const { user } = useAuth();
  const facts = useDashboardFacts();
  const agentOn = useFlag('agent');
  const hidden = useMemo<HiddenSteps>(() => (agentOn ? new Set() : new Set<StepId>(['preparing'])), [agentOn]);

  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/dashboard';
  const { goal, step } = selectionFrom({ goal: params?.get('goal') ?? null, step: params?.get('step') ?? null }, facts, hidden);

  const select = useCallback(
    (next: { goal: GoalId; step?: StepId }) => {
      const query = new URLSearchParams(params?.toString() ?? '');
      query.set('goal', next.goal);
      if (next.step) query.set('step', next.step);
      else query.delete('step');
      router.replace(`${pathname}?${query.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const steps = goalSteps(goal, facts, hidden);
  const active = steps.find((s) => s.id === step) ?? steps[0]!;
  const name = firstNameOf(user?.name);

  return (
    <div className={styles.page}>
      <header className={styles.greeting}>
        <h1>{name ? t('hi', { name }) : t('hi_anon')}</h1>
        <p>{t('subtitle')}</p>
      </header>

      <div className={styles.goals} role="group" aria-label={t('goals_aria')}>
        {GOALS.map((g, i) => (
          <span key={g} className={styles.goalItem}>
            {i > 0 ? <span className={styles.goalRule} aria-hidden="true" data-on={GOALS.indexOf(goal) >= i ? 'true' : 'false'} /> : null}
            <button
              type="button"
              className={styles.goalTab}
              aria-pressed={g === goal}
              onClick={() => select({ goal: g })}
            >
              {t(`goal.${g}`)}
            </button>
          </span>
        ))}
      </div>

      <section className={styles.focus} aria-label={t('progress_aria', { goal: t(`goal.${goal}`) })}>
        <ProgressCard steps={steps} activeId={active.id} onSelect={(id) => select({ goal, step: id })} />
        <HeroCard goal={goal} progress={active} facts={facts} />
      </section>

      <JobMatches />

      <AskBar />
    </div>
  );
}

/** "74%", "1/3" while a count is under its goal, the bare count once it is met (with the done check beside it). */
function valueText(t: ReturnType<typeof useTranslations>, s: StepProgress): string {
  if (s.value === null) return t('value_unknown');
  if (s.kind === 'percent') return t('value_percent', { value: s.value });
  return s.done ? String(s.value) : t('value_count', { value: s.value, target: s.target ?? 0 });
}

function ProgressCard({
  steps,
  activeId,
  onSelect,
}: {
  steps: StepProgress[];
  activeId: StepId;
  onSelect: (id: StepId) => void;
}) {
  const t = useTranslations('dashboard');
  return (
    <div className={styles.progress}>
      <h2 className={styles.progressTitle}>{t('progress')}</h2>
      <ul className={styles.progressList}>
        {steps.map((s) => {
          const Icon = STEP_ICONS[s.id];
          const on = s.id === activeId;
          const value = valueText(t, s);
          return (
            <li key={s.id}>
              <button
                type="button"
                className={styles.row}
                data-on={on ? 'true' : 'false'}
                aria-pressed={on}
                onClick={() => onSelect(s.id)}
              >
                <span className={styles.rowIcon} aria-hidden="true">
                  <Icon size={24} />
                  {s.done ? (
                    <span className={styles.rowDone}>
                      <IconCheck size={10} />
                    </span>
                  ) : null}
                </span>
                <span className={styles.rowBody}>
                  <span className={styles.rowHead}>
                    <span className={styles.rowLabel}>{t(`steps.${s.id}.label`)}</span>
                    <span className={styles.rowValue}>{s.value === null ? '—' : value}</span>
                  </span>
                  <span
                    className={styles.bar}
                    role="progressbar"
                    aria-label={t(`steps.${s.id}.label`)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(s.fraction * 100)}
                    aria-valuetext={value}
                  >
                    <span className={styles.barFill} style={{ width: `${Math.round(s.fraction * 100)}%` }} />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HeroCard({ goal, progress, facts }: { goal: GoalId; progress: StepProgress; facts: DashboardFacts }) {
  const t = useTranslations('dashboard');
  const state = heroState(progress, facts);
  const id = progress.id;
  const score = id === 'resume_check' ? facts.resumeScore : null;
  const title =
    state === 'no_resume'
      ? t('steps.resume_check.title_no_resume')
      : state === 'start'
        ? t(`steps.${id}.title_start`)
        : id === 'resume_check'
          ? score !== null && score >= STRONG_SCORE
            ? t('steps.resume_check.title_good')
            : t('steps.resume_check.title_more')
          : id === 'profile'
            ? t('steps.profile.title_more', { percent: progress.value ?? 0 })
            : t(`steps.${id}.title_more`);
  const body =
    state === 'no_resume'
      ? t('steps.resume_check.body_no_resume')
      : state === 'start'
        ? t(`steps.${id}.body_start`)
        : id === 'resume_check'
          ? t('steps.resume_check.body_more', { score: score ?? 0 })
          : t(`steps.${id}.body_more`);
  const cta = state === 'no_resume' ? t('steps.resume_check.cta_no_resume') : t(`steps.${id}.cta`);
  const href = stepHref(id, facts);
  const Icon = STEP_ICONS[id];
  const showResume = (id === 'resume_check' || id === 'tailored') && facts.primaryResumeId;

  return (
    <article className={styles.hero} aria-live="polite">
      <div className={styles.heroCopy}>
        <p className={styles.heroTag}>{t(`goal.${goal}`)}</p>
        <h2 className={styles.heroTitle}>{title}</h2>
        <p className={styles.heroBody}>{body}</p>
        <Link href={href} className={styles.heroCta}>
          <span>{cta}</span>
          <IconArrow size={16} />
        </Link>
      </div>
      <div className={styles.heroVisual} aria-hidden="true">
        {showResume && facts.primaryResumeId ? (
          <div className={styles.heroResume}>
            <ResumeThumb resumeId={facts.primaryResumeId} />
            {id === 'resume_check' && score !== null ? (
              <span className={styles.heroScore} data-strong={score >= STRONG_SCORE ? 'true' : 'false'}>
                <strong>{t('value_percent', { value: Math.round(score) })}</strong>
                <span>{t('score_label')}</span>
              </span>
            ) : null}
          </div>
        ) : (
          <div className={styles.heroArt}>
            <span className={styles.heroArtTile} data-tone={goal}>
              <Icon size={44} />
            </span>
            <span className={styles.heroArtMeter}>
              <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
