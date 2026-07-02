'use client';

// InterviewerPicker — Step 02 (proto `PersonaCard` grid → `.iv-persona`). A
// curated roster of interviewer personas from `mock.catalog`, each with a
// two-stop gradient orb, an ARCHETYPE chip (warmup/behavioral/breadth/potential/
// depth), difficulty pips, and a one-line style. Selecting lifts the id.
//
// All persona display text (role/blurb/style/company) is localized via i18n keys
// mock.setup.personas.<id>.* with the catalog's English as a safe fallback.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RAMockInterviewer } from '../../../lib/api/v2/types';

/** Collapsed default: show only the N most role-relevant interviewers. */
const COLLAPSE_LIMIT = 6;

const DIFFICULTY_KEY = ['', 'easy', 'medium', 'hard'] as const;

function PersonaCard({
  persona,
  active,
  recommended,
  onPick,
}: {
  persona: RAMockInterviewer;
  active: boolean;
  recommended?: boolean;
  onPick: () => void;
}) {
  const t = useTranslations('mock');
  // Localized persona field with the catalog English as a fallback.
  const tr = (field: 'role' | 'blurb' | 'style' | 'company'): string => {
    const key = `setup.personas.${persona.id}.${field}`;
    return t.has(key) ? t(key) : persona[field];
  };
  const archetypeKey = `setup.archetype.${persona.archetype}`;
  return (
    <button
      type="button"
      className={`iv-persona ${active ? 'active' : ''} ${recommended ? 'recommended' : ''}`}
      onClick={onPick}
    >
      <div
        className="iv-persona-orb"
        style={{
          background: `radial-gradient(circle at 30% 30%, ${persona.palette[0]}, transparent 60%),
                       radial-gradient(circle at 70% 70%, ${persona.palette[1]}, transparent 60%)`,
          boxShadow: `0 0 20px ${persona.palette[0]}55`,
        }}
      />
      <div className="iv-persona-body">
        <div className="iv-persona-name">
          {persona.name}
          <span className="iv-persona-co">{tr('company')}</span>
          {recommended ? <span className="iv-persona-rec">{t('setup.type.recommendedBadge')}</span> : null}
        </div>
        <div className="iv-persona-role">
          {tr('role')}
          {t.has(archetypeKey) && (
            <span
              className="iv-persona-archetype"
              style={{
                background: `${persona.palette[1]}22`,
                color: persona.palette[1],
                borderColor: `${persona.palette[1]}55`,
              }}
            >
              {t(archetypeKey)}
            </span>
          )}
        </div>
        <div className="iv-persona-blurb">{tr('blurb')}</div>
        <div className="iv-persona-meta">
          <div className="iv-difficulty">
            {[1, 2, 3].map((i) => (
              <span
                key={i}
                className={`iv-dpip ${i <= persona.difficulty ? 'on' : ''}`}
              />
            ))}
            <span
              style={{
                marginLeft: 6,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.12em',
              }}
            >
              {t(`setup.difficulty.${DIFFICULTY_KEY[persona.difficulty] || 'medium'}`)}
            </span>
          </div>
        </div>
        <div className="iv-persona-style">{tr('style')}</div>
      </div>
    </button>
  );
}

interface Props {
  interviewers: RAMockInterviewer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Persona ids best-suited to the chosen role (badge + sort-to-front). */
  recommendedPersonaIds?: string[];
}

export function InterviewerPicker({ interviewers, selectedId, onSelect, recommendedPersonaIds }: Props) {
  const t = useTranslations('mock');
  const [expanded, setExpanded] = useState(false);
  const recIds = recommendedPersonaIds ?? [];
  const recSet = useMemo(() => new Set(recIds), [recommendedPersonaIds]);
  // Recommended personas first (in recommendation order), then catalog order.
  const ordered = useMemo(() => {
    if (!recSet.size) return interviewers;
    const rank = new Map(recIds.map((id, i) => [id, i]));
    return [...interviewers].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    );
  }, [interviewers, recommendedPersonaIds]);

  // Collapsed: top COLLAPSE_LIMIT (recommended-first) + always the selected one.
  const collapsible = ordered.length > COLLAPSE_LIMIT;
  const visible = expanded
    ? ordered
    : ordered.filter((p, i) => i < COLLAPSE_LIMIT || p.id === selectedId);

  return (
    <section className="iv-step">
      <div className="iv-step-head">
        <span className="iv-step-num">02</span>
        <div>
          <div className="iv-step-title">{t('setup.interviewer.title')}</div>
          <div className="iv-step-sub">{t('setup.interviewer.sub')}</div>
        </div>
      </div>
      <div className="iv-persona-grid">
        {visible.map((p) => (
          <PersonaCard
            key={p.id}
            persona={p}
            active={p.id === selectedId}
            recommended={recSet.has(p.id)}
            onPick={() => onSelect(p.id)}
          />
        ))}
      </div>
      {collapsible ? (
        <button type="button" className="iv-show-all" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('setup.showFewer') : t('setup.showAll', { count: ordered.length })}
        </button>
      ) : null}
    </section>
  );
}
