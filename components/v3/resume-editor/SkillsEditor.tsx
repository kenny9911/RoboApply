'use client';

// SkillsEditor — the skill-chip editor (.rb-skills). Source:
// RoboApply_V3/resume-editor.jsx Skills section. Chips are removable; a dashed
// "+ Add skill" chip opens an inline input. The section's AI chip ("Suggest
// skills from your bullets") lives on the EditorSection bar in the page and
// calls `onSuggested` with the suggestions, which we surface as one-tap adds.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface Props {
  skills: string[];
  onChange: (next: string[]) => void;
  /** Suggestions returned by `resumes.rewrite({ mode:'skills' })`, surfaced as
   *  tappable add-chips. Cleared by the page once consumed. */
  suggestions: string[];
  onClearSuggestions: () => void;
}

export function SkillsEditor({
  skills,
  onChange,
  suggestions,
  onClearSuggestions,
}: Props) {
  const t = useTranslations('resumeEditor');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function add(skill: string) {
    const clean = skill.trim();
    if (!clean) return;
    if (skills.some((s) => s.toLowerCase() === clean.toLowerCase())) return;
    onChange([...skills, clean]);
  }

  function commitDraft() {
    add(draft);
    setDraft('');
    setAdding(false);
  }

  const pendingSuggestions = suggestions.filter(
    (s) => !skills.some((k) => k.toLowerCase() === s.toLowerCase()),
  );

  return (
    <div>
      <div className="rb-skills">
        {skills.map((s, i) => (
          <span key={`${s}-${i}`} className="rb-skill">
            {s}
            <button
              type="button"
              className="rb-skill-x"
              onClick={() => onChange(skills.filter((_, j) => j !== i))}
              aria-label={t('skills.remove', { skill: s })}
            >
              ×
            </button>
          </span>
        ))}

        {adding ? (
          <input
            className="rb-input"
            autoFocus
            value={draft}
            placeholder={t('skills.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
              if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={commitDraft}
            style={{
              width: 160,
              background: 'var(--surface)',
              border: '1px solid var(--accent-text)',
              borderRadius: 99,
              padding: '6px 11px',
              fontSize: 12.5,
            }}
          />
        ) : (
          <button
            type="button"
            className="rb-skill add"
            onClick={() => setAdding(true)}
          >
            {t('skills.add')}
          </button>
        )}
      </div>

      {pendingSuggestions.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: 'var(--accent-text)',
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            {t('skills.suggested')}
          </div>
          <div className="rb-skills">
            {pendingSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="rb-skill"
                onClick={() => add(s)}
                style={{
                  cursor: 'pointer',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-text)',
                  borderColor: 'var(--accent-text)',
                }}
              >
                + {s}
              </button>
            ))}
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 8px', fontSize: 11 }}
              onClick={onClearSuggestions}
            >
              {t('skills.dismiss_suggestions')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
