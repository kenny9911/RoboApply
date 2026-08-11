'use client';

import Link from 'next/link';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';

import { INTERVIEW_LOCALES } from '../../../lib/localeConfig';
import { mockCreditsForMinutes } from '../../../lib/mockInterviewCredits';
import { useMockRoleLabels } from '../../../lib/mockRoleLabels';
import type { IERequirements } from '../../../lib/api/interviewEngine';
import type {
  RAMockFormat,
  RAMockInterviewer,
  RAMockRoleCategory,
  RAMockSessionSummary,
  RAMockType,
} from '../../../lib/api/v2/types';
import { MarketRequirementsPanel, type PreviewState } from './MarketRequirementsPanel';
import { RecentSessionsStrip } from './RecentSessionsStrip';
import { RolePicker, type RoleSourceMode } from './RolePicker';
import styles from './PracticeSetupFlow.module.css';

type StepIndex = 0 | 1 | 2 | 3;

interface Props {
  categories: RAMockRoleCategory[];
  totalRoles: number;
  query: string;
  onQueryChange: (value: string) => void;
  activeCategory: string;
  onCategoryChange: (value: string) => void;
  selectedRole: string | null;
  effectiveRole: string | null;
  onSelectRole: (value: string) => void;
  sourceMode: RoleSourceMode;
  onSourceModeChange: (value: RoleSourceMode) => void;
  jdText: string;
  onJdTextChange: (value: string) => void;
  hasRoleSource: boolean;

  interviewers: RAMockInterviewer[];
  selectedInterviewerId: string | null;
  onSelectInterviewer: (value: string) => void;
  recommendedPersonaIds?: string[];

  types: RAMockType[];
  selectedTypeId: string | null;
  onSelectType: (value: string) => void;
  recommendedTypeIds?: string[];

  format: RAMockFormat;
  onFormatChange: (value: RAMockFormat) => void;
  language: string;
  onLanguageChange: (value: string) => void;
  durationMinutes: number;
  onDurationChange: (value: number) => void;

  recentSessions: RAMockSessionSummary[];
  onReplay: (session: RAMockSessionSummary) => void;
  onDelete: (session: RAMockSessionSummary) => void;

  previewState: PreviewState;
  requirements: IERequirements | null;
  webSources: Array<{ title: string; url: string }>;
  sampleQuestions: string[];
  groundedOn?: 'jd' | 'market' | 'role';
  canPreview: boolean;
  onPreview: () => void;
  onRetryPreview: () => void;

  creditCost: number;
  creditMinutes: number;
  creditsRemaining?: number;
  canAfford: boolean;
  startError: boolean;
  insufficientCredits: { balance: number; required: number } | null;
  canLaunch: boolean;
  starting: boolean;
  onStart: () => void;
}

const STEP_COUNT = 4;
const COLLAPSED_CHOICES = 6;
const BASE_DURATIONS = [15, 30, 45, 60];

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

export function PracticeSetupFlow({
  categories,
  totalRoles,
  query,
  onQueryChange,
  activeCategory,
  onCategoryChange,
  selectedRole,
  effectiveRole,
  onSelectRole,
  sourceMode,
  onSourceModeChange,
  jdText,
  onJdTextChange,
  hasRoleSource,
  interviewers,
  selectedInterviewerId,
  onSelectInterviewer,
  recommendedPersonaIds,
  types,
  selectedTypeId,
  onSelectType,
  recommendedTypeIds,
  format,
  onFormatChange,
  language,
  onLanguageChange,
  durationMinutes,
  onDurationChange,
  recentSessions,
  onReplay,
  onDelete,
  previewState,
  requirements,
  webSources,
  sampleQuestions,
  groundedOn,
  canPreview,
  onPreview,
  onRetryPreview,
  creditCost,
  creditMinutes,
  creditsRemaining,
  canAfford,
  startError,
  insufficientCredits,
  canLaunch,
  starting,
  onStart,
}: Props) {
  const t = useTranslations('practice');
  const { localizeRole, localizeType } = useMockRoleLabels();
  const [step, setStep] = useState<StepIndex>(0);
  const [furthestStep, setFurthestStep] = useState<StepIndex>(0);
  const [showAllInterviewers, setShowAllInterviewers] = useState(false);
  const [showAllTypes, setShowAllTypes] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const selectedInterviewer = interviewers.find((item) => item.id === selectedInterviewerId) ?? null;
  const selectedType = types.find((item) => item.id === selectedTypeId) ?? null;

  const personaRecIds = recommendedPersonaIds ?? [];
  const typeRecIds = recommendedTypeIds ?? [];
  const personaRecSet = useMemo(() => new Set(personaRecIds), [recommendedPersonaIds]);
  const typeRecSet = useMemo(() => new Set(typeRecIds), [recommendedTypeIds]);

  const orderedInterviewers = useMemo(() => {
    const rank = new Map(personaRecIds.map((id, index) => [id, index]));
    return [...interviewers].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [interviewers, recommendedPersonaIds]);

  const orderedTypes = useMemo(() => {
    const rank = new Map(typeRecIds.map((id, index) => [id, index]));
    return [...types].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [types, recommendedTypeIds]);

  const visibleInterviewers = showAllInterviewers
    ? orderedInterviewers
    : orderedInterviewers.filter((item, index) => index < COLLAPSED_CHOICES || item.id === selectedInterviewerId);
  const visibleTypes = showAllTypes
    ? orderedTypes
    : orderedTypes.filter((item, index) => index < COLLAPSED_CHOICES || item.id === selectedTypeId);

  const durationOptions = useMemo(
    () => Array.from(new Set([...BASE_DURATIONS, ...(selectedType ? [selectedType.minutes] : [])])).sort((a, b) => a - b),
    [selectedType],
  );
  const affordableDuration = creditsRemaining === undefined
    ? null
    : [...durationOptions]
        .reverse()
        .find((minutes) => creditsRemaining + 1e-9 >= mockCreditsForMinutes(minutes, creditMinutes)) ?? null;
  const creditShortage = insufficientCredits ?? (
    !canAfford && creditsRemaining !== undefined
      ? { balance: creditsRemaining, required: creditCost }
      : null
  );

  const stepReady = [
    hasRoleSource,
    !!selectedInterviewer && !!selectedType,
    !!format && !!language && durationMinutes > 0,
    canLaunch && canAfford,
  ];

  const stepLabels = [
    t('setup.guide.steps.job'),
    t('setup.guide.steps.style'),
    t('setup.guide.steps.preferences'),
    t('setup.guide.steps.review'),
  ];

  useLayoutEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-practice-heading]')?.focus();
  }, [step]);

  function goToStep(next: StepIndex) {
    if (next > furthestStep) return;
    setStep(next);
  }

  function goNext() {
    if (!stepReady[step] || step === 3) return;
    const next = (step + 1) as StepIndex;
    setFurthestStep((current) => Math.max(current, next) as StepIndex);
    setStep(next);
  }

  function personaText(persona: RAMockInterviewer, field: 'role' | 'company'): string {
    const key = `setup.personas.${persona.id}.${field}`;
    return t.has(key) ? t(key) : persona[field];
  }

  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <div>
          <p className={styles.eyebrow}>{t('setup.guide.eyebrow')}</p>
          <h1>{t('setup.guide.title')}</h1>
          <p className={styles.lead}>{t('setup.guide.sub')}</p>
        </div>

        {recentSessions.length > 0 ? (
          <details className={styles.recentDisclosure}>
            <summary>
              {t('setup.guide.recent', { count: recentSessions.length })}
              <span aria-hidden>⌄</span>
            </summary>
            <div className={styles.recentBody}>
              <RecentSessionsStrip sessions={recentSessions} onReplay={onReplay} onDelete={onDelete} />
            </div>
          </details>
        ) : null}
      </header>

      <section ref={panelRef} className={styles.panel} aria-label={t('setup.guide.title')}>
        <ol className={styles.stepper} aria-label={t('setup.guide.progressLabel')}>
          {stepLabels.map((label, index) => {
            const current = index === step;
            const complete = index < step || (index < furthestStep && stepReady[index]);
            const available = index <= furthestStep;
            return (
              <li key={label}>
                <button
                  type="button"
                  className={`${styles.stepButton} ${current ? styles.currentStep : ''} ${complete ? styles.completeStep : ''}`}
                  aria-label={`${t('setup.guide.stepCount', { current: index + 1, total: STEP_COUNT })} · ${label}`}
                  aria-current={current ? 'step' : undefined}
                  disabled={!available}
                  onClick={() => goToStep(index as StepIndex)}
                >
                  <span className={styles.stepMark} aria-hidden>{complete ? '✓' : index + 1}</span>
                  <span className={styles.stepText} aria-hidden>{label}</span>
                  <span className={styles.mobileStepText} aria-hidden>
                    {t('setup.guide.stepCount', { current: index + 1, total: STEP_COUNT })} · {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className={styles.content}>
          {step === 0 ? (
            <div>
              <StepHeading title={t('setup.guide.jobTitle')} sub={t('setup.guide.jobSub')} />
              <div className={styles.roleStep}>
                <RolePicker
                  compact
                  categories={categories}
                  totalRoles={totalRoles}
                  query={query}
                  onQueryChange={onQueryChange}
                  activeCategory={activeCategory}
                  onCategoryChange={onCategoryChange}
                  selectedRole={selectedRole}
                  onSelectRole={onSelectRole}
                  sourceMode={sourceMode}
                  onSourceModeChange={onSourceModeChange}
                  jdText={jdText}
                  onJdTextChange={onJdTextChange}
                />
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div>
              <StepHeading title={t('setup.guide.styleTitle')} sub={t('setup.guide.styleSub')} />

              <div className={styles.planSummary}>
                <div className={styles.planCard}>
                  <span className={styles.planLabel}>{t('setup.launch.interviewer')}</span>
                  <strong>{selectedInterviewer?.name ?? t('setup.launch.pickInterviewer')}</strong>
                  <span>{selectedInterviewer ? personaText(selectedInterviewer, 'role') : t('setup.guide.planPending')}</span>
                  {selectedInterviewer && personaRecSet.has(selectedInterviewer.id) ? (
                    <span className={styles.recommended}>{t('setup.type.recommendedBadge')}</span>
                  ) : null}
                </div>
                <div className={styles.planCard}>
                  <span className={styles.planLabel}>{t('setup.guide.focusLabel')}</span>
                  <strong>{selectedType ? localizeType(selectedType.id, 'label', selectedType.label) : t('setup.launch.pickType')}</strong>
                  <span>
                    {selectedType
                      ? localizeType(selectedType.id, 'sub', selectedType.sub)
                      : t('setup.guide.planPending')}
                  </span>
                  {selectedType && typeRecSet.has(selectedType.id) ? (
                    <span className={styles.recommended}>{t('setup.type.recommendedBadge')}</span>
                  ) : null}
                </div>
              </div>

              <details className={styles.customize}>
                <summary>{t('setup.guide.changeSetup')}</summary>
                <div className={styles.customizeBody}>
                  <fieldset>
                    <legend>{t('setup.interviewer.title')}</legend>
                    <div
                      className={styles.choiceGrid}
                      role="radiogroup"
                      aria-label={t('setup.interviewer.title')}
                      onKeyDown={(event) => moveRadioSelection(
                        event,
                        visibleInterviewers.map((item) => item.id),
                        selectedInterviewerId,
                        onSelectInterviewer,
                      )}
                    >
                      {visibleInterviewers.map((persona, index) => {
                        const active = persona.id === selectedInterviewerId;
                        const hasActiveChoice = visibleInterviewers.some((item) => item.id === selectedInterviewerId);
                        return (
                          <button
                            key={persona.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            tabIndex={active || (!hasActiveChoice && index === 0) ? 0 : -1}
                            className={`${styles.compactChoice} ${active ? styles.selectedChoice : ''}`}
                            onClick={() => onSelectInterviewer(persona.id)}
                          >
                            <span className={styles.choiceMark} aria-hidden />
                            <span>
                              <strong>{persona.name}</strong>
                              <small>{personaText(persona, 'role')}</small>
                            </span>
                            {personaRecSet.has(persona.id) ? <em>{t('setup.type.recommendedBadge')}</em> : null}
                          </button>
                        );
                      })}
                    </div>
                    {orderedInterviewers.length > COLLAPSED_CHOICES ? (
                      <button type="button" className={styles.showMore} onClick={() => setShowAllInterviewers((value) => !value)}>
                        {showAllInterviewers ? t('setup.showFewer') : t('setup.showAll', { count: orderedInterviewers.length })}
                      </button>
                    ) : null}
                  </fieldset>

                  <fieldset>
                    <legend>{t('setup.guide.focusLabel')}</legend>
                    <div
                      className={styles.choiceGrid}
                      role="radiogroup"
                      aria-label={t('setup.guide.focusLabel')}
                      onKeyDown={(event) => moveRadioSelection(
                        event,
                        visibleTypes.map((item) => item.id),
                        selectedTypeId,
                        onSelectType,
                      )}
                    >
                      {visibleTypes.map((item, index) => {
                        const active = item.id === selectedTypeId;
                        const hasActiveChoice = visibleTypes.some((choice) => choice.id === selectedTypeId);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            tabIndex={active || (!hasActiveChoice && index === 0) ? 0 : -1}
                            className={`${styles.compactChoice} ${active ? styles.selectedChoice : ''}`}
                            onClick={() => onSelectType(item.id)}
                          >
                            <span className={styles.choiceMark} aria-hidden />
                            <span>
                              <strong>{localizeType(item.id, 'label', item.label)}</strong>
                              <small>{t('setup.type.minutes', { minutes: item.minutes })}</small>
                            </span>
                            {typeRecSet.has(item.id) ? <em>{t('setup.type.recommendedBadge')}</em> : null}
                          </button>
                        );
                      })}
                    </div>
                    {orderedTypes.length > COLLAPSED_CHOICES ? (
                      <button type="button" className={styles.showMore} onClick={() => setShowAllTypes((value) => !value)}>
                        {showAllTypes ? t('setup.showFewer') : t('setup.showAll', { count: orderedTypes.length })}
                      </button>
                    ) : null}
                  </fieldset>
                </div>
              </details>
            </div>
          ) : null}

          {step === 2 ? (
            <div>
              <StepHeading title={t('setup.guide.preferencesTitle')} sub={t('setup.guide.preferencesSub')} />

              <fieldset className={styles.preferenceGroup}>
                <legend>{t('setup.launch.mode')}</legend>
                <div
                  className={styles.formatGrid}
                  role="radiogroup"
                  aria-label={t('setup.launch.mode')}
                  onKeyDown={(event) => moveRadioSelection(
                    event,
                    ['video', 'voice'] as RAMockFormat[],
                    format,
                    onFormatChange,
                  )}
                >
                  {(['video', 'voice'] as const).map((value) => {
                    const active = format === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        tabIndex={active ? 0 : -1}
                        className={`${styles.formatChoice} ${active ? styles.selectedChoice : ''}`}
                        onClick={() => onFormatChange(value)}
                      >
                        <span aria-hidden className={styles.formatIcon}>{value === 'video' ? '▣' : '◉'}</span>
                        <span>
                          <strong>{t(`setup.format.${value}.title`)}</strong>
                          <small>{t(`setup.guide.${value}Hint`)}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <div className={styles.preferenceGrid}>
                <label>
                  <span>{t('setup.langDuration.languageLabel')}</span>
                  <select value={language} onChange={(event) => onLanguageChange(event.target.value)}>
                    {INTERVIEW_LOCALES.map((locale) => (
                      <option key={locale.code} value={locale.code}>{locale.label}</option>
                    ))}
                  </select>
                </label>

                <fieldset>
                  <legend>{t('setup.langDuration.durationLabel')}</legend>
                  <div
                    className={styles.durationGroup}
                    role="radiogroup"
                    aria-label={t('setup.langDuration.durationLabel')}
                    onKeyDown={(event) => moveRadioSelection(
                      event,
                      durationOptions,
                      durationMinutes,
                      onDurationChange,
                    )}
                  >
                    {durationOptions.map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        role="radio"
                        aria-checked={minutes === durationMinutes}
                        tabIndex={minutes === durationMinutes ? 0 : -1}
                        className={minutes === durationMinutes ? styles.selectedDuration : ''}
                        onClick={() => onDurationChange(minutes)}
                      >
                        {t('setup.type.minutes', { minutes })}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <StepHeading title={t('setup.guide.reviewTitle')} sub={t('setup.guide.reviewSub')} />

              <dl className={styles.reviewList}>
                <ReviewRow
                  label={t('setup.launch.role')}
                  value={effectiveRole ? localizeRole(effectiveRole) : t('setup.launch.roleFromJd')}
                />
                <ReviewRow label={t('setup.launch.interviewer')} value={selectedInterviewer?.name ?? t('setup.launch.pickInterviewer')} />
                <ReviewRow
                  label={t('setup.guide.focusLabel')}
                  value={selectedType ? localizeType(selectedType.id, 'label', selectedType.label) : t('setup.launch.pickType')}
                />
                <ReviewRow label={t('setup.launch.mode')} value={t(`setup.modeShort.${format}`)} />
                <ReviewRow
                  label={t('setup.langDuration.languageLabel')}
                  value={INTERVIEW_LOCALES.find((locale) => locale.code === language)?.label ?? language}
                />
                <ReviewRow label={t('setup.langDuration.durationLabel')} value={t('setup.type.minutes', { minutes: durationMinutes })} />
              </dl>

              <details className={styles.previewDisclosure}>
                <summary>{t('setup.guide.previewSummary')}</summary>
                <MarketRequirementsPanel
                  compact
                  state={previewState}
                  requirements={requirements}
                  webSources={webSources}
                  sampleQuestions={sampleQuestions}
                  groundedOn={groundedOn}
                  canPreview={canPreview}
                  onPreview={onPreview}
                  onRetry={onRetryPreview}
                />
              </details>

              <div className={styles.creditRow}>
                <span>{t('setup.creditCost', { n: creditCost })}</span>
                {creditsRemaining !== undefined ? <span>{t('setup.creditsRemaining', { n: creditsRemaining })}</span> : null}
              </div>

              {startError ? <p role="alert" className={styles.error}>{t('setup.startError')}</p> : null}

              {creditShortage ? (
                <div role="alert" className={styles.creditAlert}>
                  <span>{t('setup.insufficientCredits', creditShortage)}</span>
                  <div className={styles.creditActions}>
                    {affordableDuration !== null && affordableDuration !== durationMinutes ? (
                      <button type="button" className="btn" onClick={() => onDurationChange(affordableDuration)}>
                        {t('setup.langDuration.durationLabel')}: {t('setup.type.minutes', { minutes: affordableDuration })}
                      </button>
                    ) : null}
                    <Link className="btn primary" href="/settings#billing">{t('setup.getCredits')}</Link>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className={styles.actions}>
          <button
            type="button"
            className="btn"
            disabled={step === 0}
            onClick={() => setStep((step - 1) as StepIndex)}
          >
            {t('setup.guide.back')}
          </button>
          <span>{t('setup.guide.stepCount', { current: step + 1, total: STEP_COUNT })}</span>
          {step < 3 ? (
            <button type="button" className="btn primary" disabled={!stepReady[step]} onClick={goNext}>
              {t('setup.guide.continue')}
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={!canLaunch || !canAfford || starting} onClick={onStart}>
              {starting ? t('setup.launch.starting') : t('setup.launch.start')}
            </button>
          )}
        </footer>
      </section>

      <p className={styles.reassurance}>{t('setup.guide.reassurance')}</p>
    </div>
  );
}

function StepHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <header className={styles.stepHeading}>
      <h2 data-practice-heading tabIndex={-1}>{title}</h2>
      <p>{sub}</p>
    </header>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
