'use client';

// /practice setup — ONE screen, not a wizard.
//
// The shape follows what actually has to be decided:
//
//   • The job is the only required input. It gets the top of the page
//     (PracticeTargetPicker: search real openings, browse an industry, or
//     paste a post; optionally name the company).
//   • Everything else is a PLAN, written for that job: the interview prep
//     agents return the interviewers a real loop for it would include, the
//     angles it is tested on, the company's interview style and a strategy.
//     The plan shows as a row of chips, each opening an inline tray of the
//     job's own alternatives. No navigation, no modal.
//   • The launch dock is sticky and live from the moment the plan is ready, so
//     the shortest path through this page is pick-a-job → Start.
//   • The prep brief under the dock is the coaching before the interview:
//     what the job tests, how the company interviews (with its sources), how
//     this practice will run, and what to prepare.
//   • Past sessions sit at the top as a lane: repeating a practice is the
//     single highest-intent action a returning candidate takes.
//
// Two things the screen only offers when they exist:
//   • the Format chip (video or voice) — `formatChoice` is false where the
//     practice runs in writing;
//   • the "Get credits" link — `canGetCredits` is false where nothing is on
//     sale, so a credit shortfall never points at a page that sells nothing.

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';

import { INTERVIEW_LOCALES } from '../../../lib/localeConfig';
import { canAffordMinutes, longestAffordableMinutes, mockCreditsForMinutes } from '../../../lib/mockInterviewCredits';
import { CN_FORMAT_DURATIONS, isCnFormatType, useLocalizeType } from '../../features/practice-cn';
import { AiGeneratedBadge } from '../../features/market';
import type { PrepFocus, PrepInterviewer, PrepPlan } from '../../../lib/api/interviewEngine';
import type { RAMockFormat, RAMockSessionSummary } from '../../../lib/api/v2/types';
import {
  IconCamera,
  IconChevron,
  IconClock,
  IconGlobe,
  IconHistory,
  IconPerson,
  IconRefresh,
  IconTarget,
  IconTrash,
  IconWaveform,
} from '../primitives/Iconset';
import { JD_MIN_CHARS, type LoadState, type RoleSourceMode } from './PracticeTargetPicker';
import styles from './PracticeSetupFlow.module.css';

export { JD_MIN_CHARS, type RoleSourceMode };

/** Where practice packs and plans are sold: the plan picker, like the report's
 *  "get more" link (features/practice/PracticeReportEnd PRACTICE_PLANS_HREF). */
const PRACTICE_PLANS_HREF = '/settings/billing#plans';

/** The practice lengths. 20 is the default (one practice credit at the standard rate). */
export const PRACTICE_DURATIONS: readonly number[] = [15, 20, 30];
export const DEFAULT_PRACTICE_MINUTES = 20;

/**
 * The lengths offered for a focus's format, shortest first. GoApply's
 * AI-interview format runs 20–30 minutes, so only the practice lengths in that
 * range are offered for it.
 */
export function practiceDurationOptions(type: { id: string } | null | undefined): number[] {
  if (isCnFormatType(type?.id)) return [...CN_FORMAT_DURATIONS];
  return [...PRACTICE_DURATIONS];
}

/** Recent sessions shown in the lane before "show all". */
const RECENT_LANE_LIMIT = 3;

/** How long each "preparing" step stays highlighted (the steps are what the server does, in order). */
const PREP_STEP_MS = 7000;

type TrayKey = 'interviewer' | 'focus' | 'mode' | 'length' | 'language';

interface Props {
  /** The "which job" section (PracticeTargetPicker). */
  targetSection: ReactNode;
  /** A job, role or post is chosen: the plan is (being) written for it. */
  hasRoleSource: boolean;
  /** The role the dock names. */
  effectiveRole: string | null;
  company: string | null;

  planState: LoadState;
  /** True while AI practice is not allowed here (the gate notice says why): no plan area is shown. */
  planBlocked?: boolean;
  plan: PrepPlan | null;
  onRetryPlan: () => void;
  selectedInterviewerKey: string | null;
  onSelectInterviewer: (key: string) => void;
  selectedFocusKey: string | null;
  onSelectFocus: (key: string) => void;

  format: RAMockFormat;
  onFormatChange: (value: RAMockFormat) => void;
  /**
   * False hides the Format chip and its tray: there is no video or voice to
   * choose where the practice runs in writing. Default true.
   */
  formatChoice?: boolean;
  language: string;
  onLanguageChange: (value: string) => void;
  durationMinutes: number;
  durationOptions: number[];
  onDurationChange: (value: number) => void;

  recentSessions: RAMockSessionSummary[];
  onReplay: (session: RAMockSessionSummary) => void;
  onRepeat: (session: RAMockSessionSummary) => void;
  onDelete: (session: RAMockSessionSummary) => void;

  creditCost: number;
  creditMinutes: number;
  creditsRemaining?: number;
  canAfford: boolean;
  /** Why the last Start failed, if it did: a plain network problem, a busy
   *  interview service, or anything else. */
  startError: 'network' | 'busy' | 'generic' | null;
  insufficientCredits: { balance: number; required: number } | null;
  /**
   * False when there is nothing to buy here (no practice pack on sale, no plan
   * that raises the allowance): the shortfall notice then states the numbers
   * without a "Get credits" link. Default true.
   */
  canGetCredits?: boolean;
  canLaunch: boolean;
  starting: boolean;
  onStart: () => void;

  // ── WP-43 slots (practice from a job, notices, recording) ──
  /** Under the intro: one-line notices. */
  topSlot?: ReactNode;
  /** Next to the intro copy: e.g. the "Practice questions" link. */
  introAside?: ReactNode;
  /** In the launch dock, above Start: the recording row. */
  dockSlot?: ReactNode;
  /** Replaces the Start label (e.g. the written practice). */
  startLabel?: string;
  /**
   * Wraps the Start button (it stays the same button). GoApply inside WeChat
   * uses it for the one-time "tell me when my report is ready" prompt
   * (SubscribeOnTap); everywhere else the button renders as is.
   */
  wrapStart?: (button: ReactNode) => ReactNode;
}

/** Roving-tabindex arrow handling shared by every radiogroup on this screen. */
function moveRadioSelection<T extends string | number>(
  event: KeyboardEvent<HTMLDivElement>,
  values: T[],
  current: T | null,
  onChange: (value: T) => void,
) {
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key) || values.length === 0) return;

  event.preventDefault();
  const currentIndex = Math.max(0, current === null ? 0 : values.indexOf(current));
  const nextIndex = key === 'Home'
    ? 0
    : key === 'End'
      ? values.length - 1
      : key === 'ArrowLeft' || key === 'ArrowUp'
        ? (currentIndex - 1 + values.length) % values.length
        : (currentIndex + 1) % values.length;

  const group = event.currentTarget;
  onChange(values[nextIndex]);
  requestAnimationFrame(() => group.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus());
}

interface Option<T extends string | number> {
  id: T;
  title: string;
  sub?: string;
  /** A second, quieter line (an interviewer's style, a focus's topics). */
  detail?: string;
  badge?: string;
  /** Rendered dimmed with an explanatory note; still selectable. */
  muted?: boolean;
}

/** The one option layout every tray uses, so the vocabulary never drifts. */
function OptionGrid<T extends string | number>({
  label,
  options,
  value,
  onChange,
  onCommit,
  columns = 2,
}: {
  label: string;
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  onCommit: () => void;
  columns?: 1 | 2 | 3;
}) {
  const ids = options.map((option) => option.id);
  const hasSelection = value !== null && ids.includes(value);

  return (
    <div
      className={styles.optionGrid}
      data-columns={columns}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => moveRadioSelection(event, ids, value, onChange)}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          tabIndex={option.id === value || (!hasSelection && index === 0) ? 0 : -1}
          className={`${styles.option} ${option.id === value ? styles.optionOn : ''} ${option.muted ? styles.optionMuted : ''}`}
          onClick={() => { onChange(option.id); onCommit(); }}
        >
          <span className={styles.optionMark} aria-hidden />
          <span className={styles.optionBody}>
            <strong>{option.title}</strong>
            {option.sub ? <small>{option.sub}</small> : null}
            {option.detail ? <small className={styles.optionDetail}>{option.detail}</small> : null}
          </span>
          {option.badge ? <em className={styles.optionBadge}>{option.badge}</em> : null}
        </button>
      ))}
    </div>
  );
}

/** "Preparing your interview": the server's steps, highlighted in turn while the plan is written. */
function PlanPreparing({ company }: { company: string | null }) {
  const t = useTranslations('practice');
  const steps = [
    t('setup.prep.plan.steps.reading'),
    ...(company ? [t('setup.prep.plan.steps.company', { company })] : []),
    t('setup.prep.plan.steps.panel'),
  ];
  const [active, setActive] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setActive((value) => Math.min(value + 1, steps.length - 1)), PREP_STEP_MS);
    return () => window.clearInterval(id);
  }, [steps.length]);
  return (
    <div className={styles.planPreparing} role="status" aria-live="polite">
      <strong>{t('setup.prep.plan.loadingTitle')}</strong>
      <ol>
        {steps.map((step, index) => (
          <li key={step} data-state={index < active ? 'done' : index === active ? 'active' : 'todo'}>
            <span aria-hidden className={styles.planStepMark} />
            {step}
          </li>
        ))}
      </ol>
      <div className={styles.skeletonChips} aria-hidden>
        {[132, 156, 108, 116, 120].map((width, index) => (
          <span key={index} className={styles.shimmer} style={{ width, height: 54, borderRadius: 'var(--r-md)' }} />
        ))}
      </div>
    </div>
  );
}

/** The prep brief: what the job tests, how the company interviews, how this practice runs, what to prepare. */
function PrepBrief({
  plan,
  focus,
  durationMinutes,
}: {
  plan: PrepPlan;
  focus: PrepFocus | null;
  durationMinutes: number;
}) {
  const t = useTranslations('practice');
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const req = plan.requirements;
  const style = plan.companyStyle;
  const strategy = plan.strategy;
  const hasRequirements = !!req.summary || req.mustHave.length > 0;
  const hasStrategy = !!strategy.summary || strategy.stages.length > 0 || strategy.tactics.length > 0;
  const hasTips = strategy.prepTips.length > 0;
  if (!hasRequirements && !style && !hasStrategy && !hasTips) return null;

  // Stage minutes from the shares the plan gave, for the length chosen now.
  const shareTotal = strategy.stages.reduce((sum, stage) => sum + stage.share, 0) || 1;
  const minutesOf = (share: number) => Math.max(1, Math.round((share / shareTotal) * durationMinutes));

  return (
    <section className={styles.prepBrief} aria-labelledby={`${bodyId}-title`}>
      <button
        type="button"
        className={styles.previewToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevron size={14} aria-hidden className={open ? styles.chevronUp : undefined} />
        <span id={`${bodyId}-title`}>{t('setup.prep.brief.title')}</span>
        <AiGeneratedBadge />
      </button>

      {open ? (
        <div id={bodyId} className={styles.prepBriefBody}>
          {hasRequirements ? (
            <div className={styles.prepBlock}>
              <h3>{t('setup.prep.brief.requirements')}</h3>
              {req.summary ? <p>{req.summary}</p> : null}
              {req.mustHave.length ? (
                <ul className={styles.tagList} aria-label={t('setup.prep.brief.mustHave')}>
                  {req.mustHave.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
              {focus && focus.topics.length ? (
                <p className={styles.fieldHint}>{t('setup.prep.brief.focusTopics', { focus: focus.label, topics: focus.topics.join(' · ') })}</p>
              ) : null}
            </div>
          ) : null}

          {style ? (
            <div className={styles.prepBlock}>
              <h3>{t('setup.prep.brief.company', { company: style.company })}</h3>
              <p className={styles.fieldHint}>
                {style.basis === 'sources'
                  ? t('setup.prep.brief.companySourced')
                  : t('setup.prep.brief.companyGeneral', { company: style.company })}
              </p>
              <p>{style.summary}</p>
              {style.stages.length ? (
                <ol className={styles.stageList}>
                  {style.stages.map((stage) => (
                    <li key={stage.name}>
                      <strong>{stage.name}</strong>
                      {stage.description ? <span>{stage.description}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {style.values.length ? (
                <>
                  <h4>{t('setup.prep.brief.values')}</h4>
                  <ul className={styles.tagList}>
                    {style.values.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </>
              ) : null}
              {style.evaluates.length ? (
                <>
                  <h4>{t('setup.prep.brief.evaluates')}</h4>
                  <ul className={styles.plainList}>
                    {style.evaluates.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </>
              ) : null}
              {style.sources.length ? (
                <p className={styles.sourceLinks}>
                  <span>{t('setup.prep.brief.sources')}</span>
                  {style.sources.map((source) => (
                    <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.title}
                    </a>
                  ))}
                </p>
              ) : null}
            </div>
          ) : null}

          {hasStrategy ? (
            <div className={styles.prepBlock}>
              <h3>{t('setup.prep.brief.strategy')}</h3>
              {strategy.summary ? <p>{strategy.summary}</p> : null}
              {strategy.stages.length ? (
                <ol className={styles.stageList}>
                  {strategy.stages.map((stage) => (
                    <li key={stage.name}>
                      <strong>
                        {stage.name}
                        <em>{t('setup.prep.brief.minutes', { n: minutesOf(stage.share) })}</em>
                      </strong>
                      {stage.goal ? <span>{stage.goal}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {strategy.tactics.length ? (
                <>
                  <h4>{t('setup.prep.brief.tactics')}</h4>
                  <ul className={styles.plainList}>
                    {strategy.tactics.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          {hasTips ? (
            <div className={styles.prepBlock}>
              <h3>{t('setup.prep.brief.prepTips')}</h3>
              <ul className={styles.plainList}>
                {strategy.prepTips.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          ) : null}

          <p className={styles.fieldHint}>{t('setup.prep.brief.aiNote')}</p>
        </div>
      ) : null}
    </section>
  );
}

export function PracticeSetupFlow({
  targetSection,
  hasRoleSource,
  effectiveRole,
  company,
  planState,
  planBlocked = false,
  plan,
  onRetryPlan,
  selectedInterviewerKey,
  onSelectInterviewer,
  selectedFocusKey,
  onSelectFocus,
  format,
  onFormatChange,
  formatChoice = true,
  language,
  onLanguageChange,
  durationMinutes,
  durationOptions,
  onDurationChange,
  recentSessions,
  onReplay,
  onRepeat,
  onDelete,
  creditCost,
  creditMinutes,
  creditsRemaining,
  canAfford,
  startError,
  insufficientCredits,
  canGetCredits = true,
  canLaunch,
  starting,
  onStart,
  topSlot,
  introAside,
  dockSlot,
  startLabel,
  wrapStart,
}: Props) {
  const t = useTranslations('practice');
  // Fallback plans carry catalog ids; their labels come from the bundles.
  const localizeType = useLocalizeType();

  const [tray, setTray] = useState<TrayKey | null>(null);
  const [allRecent, setAllRecent] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const trayId = useId();
  const trayRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Partial<Record<TrayKey, HTMLButtonElement | null>>>({});
  const dockRef = useRef<HTMLDivElement | null>(null);

  const interviewers = plan?.interviewers ?? [];
  const focuses = plan?.focuses ?? [];
  const selectedInterviewer = interviewers.find((item) => item.key === selectedInterviewerKey) ?? null;
  const selectedFocus = focuses.find((item) => item.key === selectedFocusKey) ?? null;
  const planReady = hasRoleSource && planState === 'ready' && !!plan;

  // The plan's recommendation floats to the front of its tray.
  const orderedInterviewers = useMemo(() => {
    const rec = plan?.recommended.interviewerKey;
    return [...interviewers].sort((a, b) => Number(b.key === rec) - Number(a.key === rec));
  }, [interviewers, plan]);
  const orderedFocuses = useMemo(() => {
    const rec = plan?.recommended.focusKey;
    return [...focuses].sort((a, b) => Number(b.key === rec) - Number(a.key === rec));
  }, [focuses, plan]);

  function interviewerTitle(item: PrepInterviewer): string {
    if (!plan?.fallback) return item.title;
    const key = `setup.personas.${item.baseId}.role`;
    return t.has(key) ? t(key) : item.title;
  }

  function focusLabel(item: PrepFocus): string {
    return plan?.fallback ? localizeType(item.format, 'label', item.label) : item.label;
  }

  function focusSub(item: PrepFocus): string {
    return plan?.fallback ? localizeType(item.format, 'sub', item.description) : item.description;
  }

  // The longest interview the current balance actually covers — offered as the
  // one-click repair inside the shortfall notice.
  const affordableDuration = creditsRemaining === undefined
    ? null
    : longestAffordableMinutes(durationOptions, creditsRemaining, creditMinutes);
  const shorterDuration = affordableDuration !== null && affordableDuration !== durationMinutes ? affordableDuration : null;

  const creditShortage = insufficientCredits ?? (
    !canAfford && creditsRemaining !== undefined
      ? { balance: creditsRemaining, required: creditCost }
      : null
  );

  // ── Tray behaviour ───────────────────────────────────────────────────────

  const closeTray = useCallback((restoreFocus: boolean) => {
    setTray((current) => {
      if (current && restoreFocus) chipRefs.current[current]?.focus();
      return null;
    });
  }, []);

  // A tray is an inline region, not a dialog: it does not trap focus, but Escape
  // still closes it and hands focus back to the chip that opened it.
  useEffect(() => {
    if (!tray) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeTray(true); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tray, closeTray]);

  // Opening a tray moves focus to its first control, so keyboard and pointer
  // users land in the same place.
  useEffect(() => {
    if (!tray) return;
    trayRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"], [role="radio"]')?.focus();
  }, [tray]);

  // Losing the plan collapses the trays; an open tray would be pointing at
  // controls that are no longer on screen. The same goes for the Format tray
  // once there is no format to choose.
  useEffect(() => {
    if (!planReady) setTray(null);
  }, [planReady]);

  useEffect(() => {
    if (!formatChoice) setTray((current) => (current === 'mode' ? null : current));
  }, [formatChoice]);

  function toggleTray(key: TrayKey) {
    setTray((current) => (current === key ? null : key));
  }

  const languageLabel = INTERVIEW_LOCALES.find((locale) => locale.code === language)?.label ?? language;
  const recInterviewer = plan?.recommended.interviewerKey ?? null;
  const recFocus = plan?.recommended.focusKey ?? null;

  const allChips: Array<{
    key: TrayKey;
    icon: ReactNode;
    label: string;
    value: string;
    suggested: boolean;
  }> = [
    {
      key: 'interviewer',
      icon: <IconPerson size={15} />,
      label: t('setup.launch.interviewer'),
      value: selectedInterviewer?.name ?? t('setup.launch.pickInterviewer'),
      suggested: !!selectedInterviewer && selectedInterviewer.key === recInterviewer,
    },
    {
      key: 'focus',
      icon: <IconTarget size={15} />,
      label: t('setup.flow.chip.focus'),
      value: selectedFocus ? focusLabel(selectedFocus) : t('setup.launch.pickType'),
      suggested: !!selectedFocus && selectedFocus.key === recFocus,
    },
    {
      key: 'mode',
      icon: format === 'video' ? <IconCamera size={15} /> : <IconWaveform size={15} />,
      label: t('setup.flow.chip.mode'),
      value: t(`setup.modeShort.${format}`),
      suggested: false,
    },
    {
      key: 'length',
      icon: <IconClock size={15} />,
      label: t('setup.langDuration.durationLabel'),
      value: t('setup.type.minutes', { minutes: durationMinutes }),
      suggested: false,
    },
    {
      key: 'language',
      icon: <IconGlobe size={15} />,
      label: t('setup.flow.chip.language'),
      value: languageLabel,
      suggested: false,
    },
  ];
  // No Format chip where there is no video or voice to choose (the written practice).
  const chips = formatChoice ? allChips : allChips.filter((chip) => chip.key !== 'mode');

  const trayTitle: Record<TrayKey, string> = {
    interviewer: t('setup.interviewer.title'),
    focus: t('setup.flow.tray.focus'),
    mode: t('setup.format.title'),
    length: t('setup.flow.tray.length'),
    language: t('setup.langDuration.languageLabel'),
  };

  const laneSessions = allRecent ? recentSessions : recentSessions.slice(0, RECENT_LANE_LIMIT);

  function repeat(session: RAMockSessionSummary) {
    onRepeat(session);
    setTray(null);
    // The brief is now filled in below; put the candidate where the decision
    // they still have to make lives.
    requestAnimationFrame(() => {
      // Optional call: jsdom (and some embedded webviews) lack scrollIntoView.
      dockRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    });
  }

  const launchTitle = effectiveRole
    ? company ? t('setup.prep.launchTitle', { role: effectiveRole, company }) : effectiveRole
    : t('setup.launch.roleFromJd');

  return (
    <div className={`${styles.page} ${hasRoleSource ? styles.pageLive : ''}`}>
      <header className={styles.intro}>
        <h1>{t('setup.flow.title')}</h1>
        <p>{t('setup.flow.sub')}</p>
        {introAside ? <div className={styles.introAside}>{introAside}</div> : null}
      </header>

      {topSlot}

      {recentSessions.length > 0 ? (
        <section className={styles.lane} aria-labelledby="practice-recent-heading">
          <div className={styles.laneHead}>
            <h2 id="practice-recent-heading">
              <IconHistory size={15} aria-hidden />
              {t('setup.flow.recentTitle')}
            </h2>
            {recentSessions.length > RECENT_LANE_LIMIT ? (
              <button type="button" className={styles.laneToggle} onClick={() => setAllRecent((v) => !v)}>
                {allRecent
                  ? t('setup.recent.showLess')
                  : t('setup.recent.showMore', { count: recentSessions.length - RECENT_LANE_LIMIT })}
              </button>
            ) : null}
          </div>

          <ul className={styles.laneGrid}>
            {laneSessions.map((session) => (
              <li key={session.id} className={styles.laneCard}>
                <div className={styles.laneTop}>
                  <span className={styles.laneScore}>{session.score}</span>
                  <span className={styles.laneWhen}>{session.when}</span>
                </div>
                <p className={styles.laneTitle}>{session.role}</p>
                <p className={styles.laneSub}>
                  {session.typeLabel} · {t('setup.recent.with', { name: session.interviewerName })}
                </p>

                {confirmDeleteId === session.id ? (
                  <div className={styles.laneConfirm} role="group" aria-label={t('setup.recent.deleteConfirm')}>
                    <span>{t('setup.recent.deleteConfirm')}</span>
                    <div>
                      <button
                        type="button"
                        className={styles.laneDanger}
                        onClick={() => { setConfirmDeleteId(null); onDelete(session); }}
                      >
                        {t('setup.recent.delete')}
                      </button>
                      <button type="button" className={styles.laneGhost} onClick={() => setConfirmDeleteId(null)}>
                        {t('setup.recent.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.laneActions}>
                    <button type="button" className={styles.lanePrimary} onClick={() => repeat(session)}>
                      {t('setup.flow.again')}
                    </button>
                    <button type="button" className={styles.laneGhost} onClick={() => onReplay(session)}>
                      {t('setup.flow.viewReport')}
                    </button>
                    <button
                      type="button"
                      className={styles.laneDelete}
                      aria-label={t('setup.recent.deleteAria')}
                      title={t('setup.recent.deleteAria')}
                      onClick={() => setConfirmDeleteId(session.id)}
                    >
                      <IconTrash size={14} aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {targetSection}

      <div className={`${styles.dock} ${hasRoleSource ? styles.dockLive : ''}`} ref={dockRef}>
        {hasRoleSource && !planBlocked ? (
          planState === 'loading' || (planState === 'idle' && !plan) ? (
            <PlanPreparing company={company} />
          ) : planState === 'error' || !plan ? (
            <div className={styles.alert} role="alert">
              <span>{t('setup.prep.plan.error')}</span>
              <span className={styles.alertActions}>
                <button type="button" className={styles.laneGhost} onClick={onRetryPlan}>
                  <IconRefresh size={13} aria-hidden /> {t('setup.prep.target.retry')}
                </button>
              </span>
            </div>
          ) : (
            <>
              <div className={styles.planHead}>
                <h2>{t('setup.flow.planLegend')}</h2>
                <p>{plan.fallback ? t('setup.prep.plan.fallbackHint') : t('setup.prep.plan.hint')}</p>
              </div>

              <div className={styles.chipRow}>
                {chips.map((chip) => {
                  const open = tray === chip.key;
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      ref={(node) => { chipRefs.current[chip.key] = node; }}
                      className={`${styles.chip} ${open ? styles.chipOpen : ''}`}
                      aria-expanded={open}
                      aria-controls={open ? trayId : undefined}
                      onClick={() => toggleTray(chip.key)}
                    >
                      <span className={styles.chipIcon} aria-hidden>{chip.icon}</span>
                      <span className={styles.chipText}>
                        <small>{chip.label}</small>
                        <strong>{chip.value}</strong>
                      </span>
                      {chip.suggested ? (
                        <span className={styles.chipDot} title={t('setup.type.recommendedBadge')}>
                          <span className="sr-only">{t('setup.type.recommendedBadge')}</span>
                        </span>
                      ) : null}
                      <IconChevron size={14} aria-hidden className={styles.chipChevron} />
                    </button>
                  );
                })}
              </div>

              {tray ? (
                <div className={styles.tray} id={trayId} ref={trayRef} role="group" aria-label={trayTitle[tray]}>
                  <div className={styles.trayHead}>
                    <h3>{trayTitle[tray]}</h3>
                    <button type="button" className={styles.trayDone} onClick={() => closeTray(true)}>
                      {t('setup.flow.done')}
                    </button>
                  </div>

                  {tray === 'interviewer' ? (
                    <OptionGrid
                      label={trayTitle.interviewer}
                      value={selectedInterviewerKey}
                      onChange={onSelectInterviewer}
                      onCommit={() => closeTray(true)}
                      options={orderedInterviewers.map((item) => ({
                        id: item.key,
                        title: item.name,
                        sub: `${interviewerTitle(item)} · ${t(`setup.prep.difficulty.${item.difficulty}`)}`,
                        detail: plan.fallback ? undefined : item.style,
                        badge: item.key === recInterviewer ? t('setup.type.recommendedBadge') : undefined,
                      }))}
                    />
                  ) : null}

                  {tray === 'focus' ? (
                    <OptionGrid
                      label={trayTitle.focus}
                      value={selectedFocusKey}
                      onChange={onSelectFocus}
                      onCommit={() => closeTray(true)}
                      options={orderedFocuses.map((item) => ({
                        id: item.key,
                        title: focusLabel(item),
                        sub: focusSub(item),
                        detail: item.topics.length ? item.topics.join(' · ') : undefined,
                        badge: item.key === recFocus ? t('setup.type.recommendedBadge') : undefined,
                      }))}
                    />
                  ) : null}

                  {tray === 'mode' && formatChoice ? (
                    <OptionGrid
                      label={trayTitle.mode}
                      value={format}
                      onChange={onFormatChange}
                      onCommit={() => closeTray(true)}
                      options={(['video', 'voice'] as const).map((value) => ({
                        id: value,
                        title: t(`setup.format.${value}.title`),
                        // WP-43: honest format lines (no "eye contact noted":
                        // only the answers are scored, never the face).
                        sub: t(`mode.${value}.desc`),
                        badge: value === 'video' ? t('setup.format.video.tag') : undefined,
                      }))}
                    />
                  ) : null}

                  {tray === 'length' ? (
                    <OptionGrid
                      label={trayTitle.length}
                      columns={3}
                      value={durationMinutes}
                      onChange={onDurationChange}
                      onCommit={() => closeTray(true)}
                      options={durationOptions.map((minutes) => {
                        const cost = mockCreditsForMinutes(minutes, creditMinutes);
                        const unaffordable = creditsRemaining !== undefined && !canAffordMinutes(minutes, creditsRemaining, creditMinutes);
                        return {
                          id: minutes,
                          title: t('setup.type.minutes', { minutes }),
                          // The price is shown where the decision is made, not as
                          // an error after the fact.
                          sub: unaffordable ? t('setup.flow.costShort', { n: cost }) : t('setup.creditCost', { n: cost }),
                          muted: unaffordable,
                        };
                      })}
                    />
                  ) : null}

                  {tray === 'language' ? (
                    <OptionGrid
                      label={trayTitle.language}
                      columns={3}
                      value={language}
                      onChange={onLanguageChange}
                      onCommit={() => closeTray(true)}
                      options={INTERVIEW_LOCALES.map((locale) => ({ id: locale.code, title: locale.label }))}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          )
        ) : null}

        {dockSlot}

        {startError ? (
          <p role="alert" className={styles.alert}>
            {startError === 'network'
              ? t('setup.startErrorNetwork')
              : startError === 'busy'
                ? t('setup.startErrorBusy')
                : t('setup.startError')}
          </p>
        ) : null}

        {creditShortage ? (
          <div role="alert" className={styles.alert}>
            {/* "Add credits" is only said, and only linked, where credits can be had. */}
            <span>{t(canGetCredits ? 'setup.insufficientCredits' : 'setup.insufficientCreditsNoPurchase', creditShortage)}</span>
            {shorterDuration !== null || canGetCredits ? (
              <span className={styles.alertActions}>
                {shorterDuration !== null ? (
                  <button type="button" className={styles.laneGhost} onClick={() => onDurationChange(shorterDuration)}>
                    {t('setup.flow.useShorter', { minutes: shorterDuration })}
                  </button>
                ) : null}
                {canGetCredits ? (
                  <Link className={styles.laneGhost} href={PRACTICE_PLANS_HREF}>{t('setup.getCredits')}</Link>
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className={styles.launch}>
          <p className={styles.launchMeta}>
            {hasRoleSource ? (
              <>
                <strong>{launchTitle}</strong>
                <span>
                  {t('setup.creditCost', { n: creditCost })}
                  {creditsRemaining !== undefined ? ` · ${t('setup.creditsRemaining', { n: creditsRemaining })}` : ''}
                </span>
              </>
            ) : (
              <span className={styles.launchPending}>{t('setup.flow.pickRoleFirst')}</span>
            )}
          </p>

          {(wrapStart ?? ((button: ReactNode) => button))(
            <button
              type="button"
              className={styles.start}
              disabled={!canLaunch || !canAfford || starting}
              onClick={onStart}
            >
              {starting ? t('setup.launch.starting') : (startLabel ?? t('setup.launch.start'))}
            </button>,
          )}
        </div>
      </div>

      {planReady && plan ? <PrepBrief plan={plan} focus={selectedFocus} durationMinutes={durationMinutes} /> : null}
    </div>
  );
}

/** First paint while the page's own data loads: the real page's silhouette, so
 *  the layout does not jump. */
export function PracticeSetupSkeleton() {
  const t = useTranslations('practice');
  return (
    <div className={styles.page} aria-busy="true" aria-live="polite">
      <header className={styles.intro}>
        <h1>{t('setup.flow.title')}</h1>
        <p>{t('setup.flow.sub')}</p>
      </header>
      <div className={styles.brief}>
        <span className="sr-only">{t('setup.loading')}</span>
        <div className={styles.skeletonHead} aria-hidden>
          <span className={styles.shimmer} style={{ width: '46%', height: 22 }} />
          <span className={styles.shimmer} style={{ width: 176, height: 38, borderRadius: 'var(--r-pill)' }} />
        </div>
        <span className={styles.shimmer} aria-hidden style={{ height: 44, marginTop: 16 }} />
        <div className={styles.skeletonChips} aria-hidden>
          {[92, 132, 108, 120, 86, 140].map((width, index) => (
            <span key={index} className={styles.shimmer} style={{ width, height: 32, borderRadius: 'var(--r-pill)' }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The page's own data failed. Nothing the candidate typed is lost — the
 *  recovery is a retry, not a restart. */
export function PracticeSetupError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('practice');
  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <h1>{t('setup.flow.title')}</h1>
      </header>
      <div className={styles.brief} role="alert">
        <div className={styles.errorState}>
          <h2>{t('setup.error.title')}</h2>
          <p>{t('setup.error.body')}</p>
          <button type="button" className={styles.start} onClick={onRetry}>
            {t('setup.error.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}
