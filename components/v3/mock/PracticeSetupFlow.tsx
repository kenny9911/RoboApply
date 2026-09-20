'use client';

// /practice setup — ONE screen, not a wizard.
//
// The wizard this replaces had four steps, three of which asked nothing: the
// recommendation engine had already picked the interviewer, the focus, the
// format, the length and the language before the candidate reached them, so
// steps 2–4 were a slideshow of decisions already made, ending in a read-only
// recap of the slideshow. Three Continue clicks to reach a button that was
// ready at step one.
//
// The shape here matches what actually has to be decided:
//
//   • The job is the only required input. It gets the top of the page.
//   • Everything else is a PLAN — pre-matched, always visible as a row of
//     chips, each one opening an inline tray of alternatives. No navigation,
//     no modal, no <details> hiding the thing the user came to change.
//   • The launch dock is sticky and live from the moment a job is chosen, so
//     the shortest path through this page is pick-a-job → Start.
//   • Past sessions sit at the top as a lane, not behind a header dropdown:
//     repeating a practice is the single highest-intent action a returning
//     candidate takes, and it prefills the whole brief in one click.

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
import {
  IconCamera,
  IconChevron,
  IconClock,
  IconGlobe,
  IconHistory,
  IconPerson,
  IconSearch,
  IconTarget,
  IconTrash,
  IconWaveform,
} from '../primitives/Iconset';
import { MarketRequirementsPanel, type PreviewState } from './MarketRequirementsPanel';
import styles from './PracticeSetupFlow.module.css';

/** Browse the catalog, or paste the job post itself. */
export type RoleSourceMode = 'role' | 'jd';

/** A job post needs at least this many characters before it's worth rewriting. */
export const JD_MIN_CHARS = 40;

/** Search results are capped so the grid never becomes a scroll region. */
const SEARCH_CAP = 12;

/** Lengths always offered, plus whatever the chosen focus recommends. */
const BASE_DURATIONS = [15, 30, 45, 60];

/** Recent sessions shown in the lane before "show all". */
const RECENT_LANE_LIMIT = 3;

type TrayKey = 'interviewer' | 'focus' | 'mode' | 'length' | 'language';

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
  onRepeat: (session: RAMockSessionSummary) => void;
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
          </span>
          {option.badge ? <em className={styles.optionBadge}>{option.badge}</em> : null}
        </button>
      ))}
    </div>
  );
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
  onRepeat,
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
  const { localizeCategory, localizeRole, localizeType } = useMockRoleLabels();

  const [tray, setTray] = useState<TrayKey | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [allRecent, setAllRecent] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const trayId = useId();
  const trayRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef<Partial<Record<TrayKey, HTMLButtonElement | null>>>({});
  const dockRef = useRef<HTMLDivElement | null>(null);

  const selectedInterviewer = interviewers.find((item) => item.id === selectedInterviewerId) ?? null;
  const selectedType = types.find((item) => item.id === selectedTypeId) ?? null;

  const personaRecIds = recommendedPersonaIds ?? [];
  const typeRecIds = recommendedTypeIds ?? [];
  const personaRecSet = useMemo(() => new Set(personaRecIds), [recommendedPersonaIds]);
  const typeRecSet = useMemo(() => new Set(typeRecIds), [recommendedTypeIds]);

  // Suggested options float to the front of their tray; the rest keep catalog order.
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

  const durationOptions = useMemo(
    () => Array.from(new Set([...BASE_DURATIONS, ...(selectedType ? [selectedType.minutes] : [])])).sort((a, b) => a - b),
    [selectedType],
  );

  // The longest interview the current balance actually covers — offered as the
  // one-click repair inside the shortfall notice.
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

  // ── Role source ──────────────────────────────────────────────────────────

  const allRoles = useMemo(() => categories.flatMap((c) => c.roles), [categories]);

  // Browsing a category renders that category whole (seven or eight roles), so
  // the grid never needs an inner scrollbar. Only search can overflow, and it
  // says so rather than silently truncating.
  const { roles: visibleRoles, overflow } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const matches = allRoles.filter(
        (r) => r.toLowerCase().includes(q) || localizeRole(r).toLowerCase().includes(q),
      );
      return { roles: matches.slice(0, SEARCH_CAP), overflow: Math.max(0, matches.length - SEARCH_CAP) };
    }
    const category = categories.find((c) => c.name === activeCategory);
    return { roles: category?.roles ?? [], overflow: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allRoles, categories, activeCategory]);

  const jdLength = jdText.trim().length;
  const hasVisibleSelectedRole = selectedRole ? visibleRoles.includes(selectedRole) : false;
  const searching = query.trim().length > 0;

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

  // Losing the role source collapses the plan; an open tray would be pointing
  // at controls that are no longer on screen.
  useEffect(() => {
    if (!hasRoleSource) setTray(null);
  }, [hasRoleSource]);

  function toggleTray(key: TrayKey) {
    setTray((current) => (current === key ? null : key));
  }

  function personaText(persona: RAMockInterviewer, field: 'role' | 'company'): string {
    const key = `setup.personas.${persona.id}.${field}`;
    return t.has(key) ? t(key) : persona[field];
  }

  const languageLabel = INTERVIEW_LOCALES.find((locale) => locale.code === language)?.label ?? language;

  const chips: Array<{
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
      suggested: !!selectedInterviewer && personaRecSet.has(selectedInterviewer.id),
    },
    {
      key: 'focus',
      icon: <IconTarget size={15} />,
      label: t('setup.flow.chip.focus'),
      value: selectedType ? localizeType(selectedType.id, 'label', selectedType.label) : t('setup.launch.pickType'),
      suggested: !!selectedType && typeRecSet.has(selectedType.id),
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
      dockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  return (
    <div className={`${styles.page} ${hasRoleSource ? styles.pageLive : ''}`}>
      <header className={styles.intro}>
        <h1>{t('setup.flow.title')}</h1>
        <p>{t('setup.flow.sub')}</p>
      </header>

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

      <section className={styles.brief} aria-labelledby="practice-role-heading">
        <div className={styles.roleHead}>
          <h2 id="practice-role-heading">{t('setup.flow.roleLegend')}</h2>

          <div
            className={styles.sourceToggle}
            role="radiogroup"
            aria-label={t('setup.flow.roleLegend')}
            onKeyDown={(event) => moveRadioSelection(
              event,
              ['role', 'jd'] as RoleSourceMode[],
              sourceMode,
              onSourceModeChange,
            )}
          >
            {(['role', 'jd'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={sourceMode === value}
                tabIndex={sourceMode === value ? 0 : -1}
                className={sourceMode === value ? styles.sourceOn : undefined}
                onClick={() => onSourceModeChange(value)}
              >
                {value === 'role' ? t('setup.role.tabBrowse') : t('setup.role.tabPaste')}
              </button>
            ))}
          </div>
        </div>

        {sourceMode === 'role' ? (
          <>
            <div className={styles.search}>
              <IconSearch size={15} aria-hidden />
              <input
                type="search"
                value={query}
                placeholder={t('setup.role.searchPlaceholder')}
                aria-label={t('setup.role.sub', { count: totalRoles })}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>

            {searching ? null : (
              <div className={styles.categories} role="tablist" aria-label={t('setup.flow.categories')}>
                {categories.map((category) => (
                  <button
                    key={category.name}
                    type="button"
                    role="tab"
                    aria-selected={activeCategory === category.name}
                    tabIndex={activeCategory === category.name ? 0 : -1}
                    className={activeCategory === category.name ? styles.categoryOn : undefined}
                    onClick={() => onCategoryChange(category.name)}
                  >
                    {localizeCategory(category.name)}
                    <span>{category.roles.length}</span>
                  </button>
                ))}
              </div>
            )}

            {visibleRoles.length === 0 ? (
              <p className={styles.noMatch}>{t('setup.flow.noMatch', { query: query.trim() })}</p>
            ) : (
              <div
                className={styles.roleGrid}
                role="radiogroup"
                aria-label={t('setup.flow.roleLegend')}
                onKeyDown={(event) => moveRadioSelection(event, visibleRoles, selectedRole, onSelectRole)}
              >
                {visibleRoles.map((role, index) => {
                  const category = categories.find((item) => item.roles.includes(role));
                  const selected = selectedRole === role;
                  return (
                    <button
                      key={role}
                      type="button"
                      role="radio"
                      aria-label={localizeRole(role)}
                      aria-checked={selected}
                      tabIndex={selected || (!hasVisibleSelectedRole && index === 0) ? 0 : -1}
                      className={`${styles.roleChip} ${selected ? styles.roleChipOn : ''}`}
                      onClick={() => onSelectRole(role)}
                    >
                      <span className={styles.optionMark} aria-hidden />
                      <span className={styles.roleChipBody}>
                        <strong>{localizeRole(role)}</strong>
                        {searching && category ? <small>{localizeCategory(category.name)}</small> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {overflow > 0 ? (
              <p className={styles.overflowHint}>{t('setup.role.more', { count: overflow })}</p>
            ) : null}
          </>
        ) : (
          <div className={styles.jd}>
            <textarea
              value={jdText}
              rows={9}
              placeholder={t('setup.role.jdPlaceholder')}
              aria-label={t('setup.role.jdPlaceholder')}
              aria-describedby="practice-jd-hint"
              onChange={(event) => onJdTextChange(event.target.value)}
            />
            <p className={styles.jdMeta}>
              <span id="practice-jd-hint">
                {jdLength > 0 && jdLength < JD_MIN_CHARS ? t('setup.role.jdTooShort') : t('setup.role.jdHint')}
              </span>
              <span className={jdLength >= JD_MIN_CHARS ? styles.jdCountOk : undefined}>
                {t('setup.role.jdCount', { count: jdLength })}
              </span>
            </p>
          </div>
        )}
      </section>

      <div className={`${styles.dock} ${hasRoleSource ? styles.dockLive : ""}`} ref={dockRef}>
        {hasRoleSource ? (
          <>
            <div className={styles.planHead}>
              <h2>{t('setup.flow.planLegend')}</h2>
              <p>{t('setup.flow.planHint')}</p>
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
                    value={selectedInterviewerId}
                    onChange={onSelectInterviewer}
                    onCommit={() => closeTray(true)}
                    options={orderedInterviewers.map((persona) => ({
                      id: persona.id,
                      title: persona.name,
                      sub: `${personaText(persona, 'role')} · ${personaText(persona, 'company')}`,
                      badge: personaRecSet.has(persona.id) ? t('setup.type.recommendedBadge') : undefined,
                    }))}
                  />
                ) : null}

                {tray === 'focus' ? (
                  <OptionGrid
                    label={trayTitle.focus}
                    value={selectedTypeId}
                    onChange={onSelectType}
                    onCommit={() => closeTray(true)}
                    options={orderedTypes.map((item) => ({
                      id: item.id,
                      title: localizeType(item.id, 'label', item.label),
                      sub: localizeType(item.id, 'sub', item.sub),
                      badge: typeRecSet.has(item.id) ? t('setup.type.recommendedBadge') : undefined,
                    }))}
                  />
                ) : null}

                {tray === 'mode' ? (
                  <OptionGrid
                    label={trayTitle.mode}
                    value={format}
                    onChange={onFormatChange}
                    onCommit={() => closeTray(true)}
                    options={(['video', 'voice'] as const).map((value) => ({
                      id: value,
                      title: t(`setup.format.${value}.title`),
                      sub: t(`setup.format.${value}.desc`),
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
                      const unaffordable = creditsRemaining !== undefined && creditsRemaining + 1e-9 < cost;
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
        ) : null}

        {startError ? <p role="alert" className={styles.alert}>{t('setup.startError')}</p> : null}

        {creditShortage ? (
          <div role="alert" className={styles.alert}>
            <span>{t('setup.insufficientCredits', creditShortage)}</span>
            <span className={styles.alertActions}>
              {affordableDuration !== null && affordableDuration !== durationMinutes ? (
                <button type="button" className={styles.laneGhost} onClick={() => onDurationChange(affordableDuration)}>
                  {t('setup.flow.useShorter', { minutes: affordableDuration })}
                </button>
              ) : null}
              <Link className={styles.laneGhost} href="/settings#billing">{t('setup.getCredits')}</Link>
            </span>
          </div>
        ) : null}

        <div className={styles.launch}>
          <p className={styles.launchMeta}>
            {hasRoleSource ? (
              <>
                <strong>{effectiveRole ? localizeRole(effectiveRole) : t('setup.launch.roleFromJd')}</strong>
                <span>
                  {t('setup.creditCost', { n: creditCost })}
                  {creditsRemaining !== undefined ? ` · ${t('setup.creditsRemaining', { n: creditsRemaining })}` : ''}
                </span>
              </>
            ) : (
              <span className={styles.launchPending}>{t('setup.flow.pickRoleFirst')}</span>
            )}
          </p>

          <button
            type="button"
            className={styles.start}
            disabled={!canLaunch || !canAfford || starting}
            onClick={onStart}
          >
            {starting ? t('setup.launch.starting') : t('setup.launch.start')}
          </button>
        </div>
      </div>

      <div className={styles.previewShell}>
        <button
          type="button"
          className={styles.previewToggle}
          aria-expanded={previewOpen}
          aria-controls="practice-preview"
          onClick={() => setPreviewOpen((value) => !value)}
        >
          <IconChevron size={14} aria-hidden className={previewOpen ? styles.chevronUp : undefined} />
          {t('setup.flow.previewToggle')}
        </button>

        {previewOpen ? (
          <div id="practice-preview" className={styles.previewBody}>
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
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** First paint while the catalog loads: the real page's silhouette, so the
 *  layout does not jump when the roles arrive. */
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
        <div className={styles.skeletonGrid} aria-hidden>
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} className={styles.shimmer} style={{ height: 56, borderRadius: 'var(--r-md)' }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The catalog failed. Nothing the candidate typed is lost — the only thing
 *  missing is the role list, so the recovery is a retry, not a restart. */
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
