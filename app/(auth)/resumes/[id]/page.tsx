'use client';

// /resumes/[id] — V3 Resume editor (Lane F). Replaces the V2 builder page.
//
// Source prototype: RoboApply_V3/resume-editor.jsx (whole). Split-pane:
//   left  = structured edit pane (Identity / Summary / Experience / Education /
//           Skills), with inline per-bullet AI + a 3-option summary rewrite +
//           AI skill suggestions
//   right = live "paper" preview that re-renders as you type
// Plus a floating Coach rail (cycling tips), a Tailor-for-a-job modal
// (pick → analyze → review diff → apply → tailored variant), and a Download
// modal.
//
// Data + state model:
//   • `useResume(id)` (existing) → seeds local `structured` parsed from
//     `resume.resumeMarkdown` via lib/resumeStructure (CLIENT-SIDE markdown↔
//     structure — RAResumeVariant carries no structured field; see contract
//     note below).
//   • All edits mutate `structured`; the preview re-renders live.
//   • A 1.2s debounce re-serializes `structured` → markdown and PATCHes
//     (`usePatchResumeMutation`) only when the markdown actually changed.
//   • Inline AI: `useResumeRewrite` (bullet / summary / skills).
//   • Tailor: `useResumeTailorDiff` + `useCreateResumeMutation`.
//   • Coach: `useResumeCoachTips`.
//
// Sections: Identity / Summary / Experience / Education / Skills are fully
// structured; any other `##` section (Projects, Certifications, Languages…)
// round-trips through `StructuredResume.extraSections` and renders below as
// an editable heading + raw-markdown card — nothing is dropped on save.
//
// Autosave rehydration: `usePatchResumeMutation.onSuccess` writes the PATCH
// response back into the detail cache, which changes `resume` identity. The
// hydration effect therefore guards: it only re-parses server markdown when
// it differs from what this editor last serialized (first load / external
// change) — an autosave echo never clobbers in-flight keystrokes or remounts
// rows.
//
// Layout: the (auth) layout wraps children in `.main-inner` (padded, max-width
// 1180). The editor is a full-bleed split, so we break out of that padding with
// a negative-margin wrapper that spans the viewport width of the main column.

import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  useResume,
  usePatchResumeMutation,
  useResumeRewrite,
  useResumeCoachTips,
  useDeleteResumeMutation,
} from '../../../../hooks/useResumes';
import { DeleteResumeConfirm } from '../../../../components/resumes/DeleteResumeConfirm';
import {
  parseResumeMarkdown,
  serializeResumeMarkdown,
  blankExperience,
  blankEducation,
  type StructuredResume,
  type StructuredExperience,
  type StructuredEducation,
} from '../../../../lib/resumeStructure';
import { analyzeResume } from '../../../../lib/resumeAnalyzer';
import {
  EditorToolbar,
  EditorSection,
  RbField,
  SummaryEditor,
  BulletRow,
  SkillsEditor,
  ResumePaper,
  CoachPanel,
  TailorModal,
  DownloadModal,
  YOUNG_HELPERS,
} from '../../../../components/v3/resume-editor';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function ResumeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const t = useTranslations('resumeEditor');
  const router = useRouter();

  const { data: resume, isLoading, isError } = useResume(id);
  const patch = usePatchResumeMutation(id);
  const rewrite = useResumeRewrite(id);
  const del = useDeleteResumeMutation();
  const { data: coachData } = useResumeCoachTips(id);

  const [structured, setStructured] = useState<StructuredResume | null>(null);
  const [resumeName, setResumeName] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [coachOpen, setCoachOpen] = useState(true);
  const [tailorOpen, setTailorOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [skillSuggestions, setSkillSuggestions] = useState<string[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);

  const lastSerializedRef = useRef('');
  const skipNextAutoSaveRef = useRef(true);
  // Which resume id the editor state was hydrated from.
  const hydratedIdRef = useRef<string | null>(null);
  // True while `structured` differs from the last-serialized markdown.
  const dirtyRef = useRef(false);
  // One-shot focus request for a freshly inserted bullet (consumed by
  // BulletRow's mount — a ref, so setting it never re-renders).
  const pendingBulletFocusRef = useRef<{ expId: string; idx: number } | null>(
    null,
  );

  // Hydrate from server — first load, resume switch, or a REAL external
  // content change. Autosave echoes (the PATCH response carrying exactly what
  // we just serialized) and refetches racing local edits are ignored so
  // typing is never interrupted and row ids/focus survive.
  useEffect(() => {
    if (!resume) return;
    const sameDoc = hydratedIdRef.current === resume.id;
    if (sameDoc && resume.resumeMarkdown === lastSerializedRef.current) return;
    if (sameDoc && dirtyRef.current) return;
    hydratedIdRef.current = resume.id;
    setStructured(parseResumeMarkdown(resume.resumeMarkdown));
    setResumeName(resume.name);
    lastSerializedRef.current = resume.resumeMarkdown;
    dirtyRef.current = false;
    skipNextAutoSaveRef.current = true;
  }, [resume]);

  // Debounced auto-save of structured edits.
  useEffect(() => {
    if (!structured || !resume) return;
    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return;
    }
    const serialized = serializeResumeMarkdown(structured);
    dirtyRef.current = serialized !== lastSerializedRef.current;
    if (!dirtyRef.current) return;

    setSaveState('saving');
    const handle = setTimeout(async () => {
      // Pre-commit before the PATCH resolves: the mutation's onSuccess writes
      // the response into the query cache, and the hydration effect compares
      // against this ref — committing after the await would race that effect.
      const prev = lastSerializedRef.current;
      lastSerializedRef.current = serialized;
      dirtyRef.current = false;
      try {
        await patch.mutateAsync({ resumeMarkdown: serialized });
        setSaveState('saved');
      } catch {
        lastSerializedRef.current = prev;
        dirtyRef.current = true;
        setSaveState('error');
      }
    }, 1200);
    return () => clearTimeout(handle);
  }, [structured, resume, patch]);

  // Debounced rename.
  useEffect(() => {
    if (!resume) return;
    if (resumeName === resume.name) return;
    const handle = setTimeout(async () => {
      try {
        await patch.mutateAsync({ name: resumeName });
      } catch {
        /* surfaced implicitly in the save badge */
      }
    }, 800);
    return () => clearTimeout(handle);
  }, [resumeName, resume, patch]);

  // Strength meter — the resume analyzer's 0..100 score (drops as issues
  // accrue, climbs as the user fixes bullets). The meter moves live as edits
  // land; the full report backs the toolbar's issue popover.
  const analysis = useMemo(() => {
    if (!structured) return null;
    try {
      return analyzeResume(structured);
    } catch {
      return null;
    }
  }, [structured]);
  const strength = analysis?.score ?? resume?.matchScoreCached ?? 72;

  // Analyzer anchors → editor section DOM ids (exp-<id> passes through: the
  // experience cards carry that id directly).
  const jumpToIssue = useCallback((anchor?: string) => {
    if (!anchor) return;
    const sectionMap: Record<string, string> = {
      'section-contact': 'identity',
      'section-target': 'identity',
      'section-summary': 'summary',
      'section-experience': 'experience',
      'section-education': 'education',
      'section-skills': 'skills',
    };
    const domId = anchor.startsWith('exp-') ? anchor : sectionMap[anchor];
    if (!domId) return;
    document
      .getElementById(domId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // ── structured mutators ──
  const updateStructured = useCallback(
    (next: StructuredResume) => setStructured(next),
    [],
  );

  const updateBullet = useCallback(
    (expId: string, bulletIdx: number, text: string) => {
      setStructured((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          experiences: cur.experiences.map((e) =>
            e.id !== expId
              ? e
              : {
                  ...e,
                  bullets: e.bullets.map((b, i) => (i === bulletIdx ? text : b)),
                },
          ),
        };
      });
    },
    [],
  );

  const updateExperienceField = useCallback(
    (expId: string, field: keyof StructuredExperience, value: string) => {
      setStructured((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          experiences: cur.experiences.map((e) =>
            e.id !== expId ? e : { ...e, [field]: value },
          ),
        };
      });
    },
    [],
  );

  const addBullet = useCallback((expId: string) => {
    setStructured((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        experiences: cur.experiences.map((e) => {
          if (e.id !== expId) return e;
          pendingBulletFocusRef.current = { expId, idx: e.bullets.length };
          return { ...e, bullets: [...e.bullets, ''] };
        }),
      };
    });
  }, []);

  /** Enter inside a bullet — insert an empty bullet directly below it. */
  const insertBulletBelow = useCallback((expId: string, idx: number) => {
    setStructured((cur) => {
      if (!cur) return cur;
      pendingBulletFocusRef.current = { expId, idx: idx + 1 };
      return {
        ...cur,
        experiences: cur.experiences.map((e) =>
          e.id !== expId
            ? e
            : {
                ...e,
                bullets: [
                  ...e.bullets.slice(0, idx + 1),
                  '',
                  ...e.bullets.slice(idx + 1),
                ],
              },
        ),
      };
    });
  }, []);

  const removeBullet = useCallback(
    (expId: string, idx: number, opts?: { focusPrev?: boolean }) => {
      setStructured((cur) => {
        if (!cur) return cur;
        if (opts?.focusPrev && idx > 0) {
          pendingBulletFocusRef.current = { expId, idx: idx - 1 };
        }
        return {
          ...cur,
          experiences: cur.experiences.map((e) =>
            e.id !== expId
              ? e
              : { ...e, bullets: e.bullets.filter((_, i) => i !== idx) },
          ),
        };
      });
    },
    [],
  );

  const moveBullet = useCallback(
    (expId: string, idx: number, dir: -1 | 1) => {
      setStructured((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          experiences: cur.experiences.map((e) => {
            if (e.id !== expId) return e;
            const to = idx + dir;
            if (to < 0 || to >= e.bullets.length) return e;
            const bullets = [...e.bullets];
            [bullets[idx], bullets[to]] = [bullets[to], bullets[idx]];
            return { ...e, bullets };
          }),
        };
      });
    },
    [],
  );

  const addExperience = useCallback(() => {
    setStructured((cur) =>
      cur ? { ...cur, experiences: [...cur.experiences, blankExperience()] } : cur,
    );
  }, []);

  const removeExperience = useCallback((expId: string) => {
    setStructured((cur) =>
      cur
        ? { ...cur, experiences: cur.experiences.filter((e) => e.id !== expId) }
        : cur,
    );
  }, []);

  const moveExperience = useCallback((expId: string, dir: -1 | 1) => {
    setStructured((cur) => {
      if (!cur) return cur;
      const idx = cur.experiences.findIndex((e) => e.id === expId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= cur.experiences.length) return cur;
      const experiences = [...cur.experiences];
      [experiences[idx], experiences[to]] = [experiences[to], experiences[idx]];
      return { ...cur, experiences };
    });
  }, []);

  const updateEducationField = useCallback(
    (eduId: string, field: keyof StructuredEducation, value: string) => {
      setStructured((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          education: cur.education.map((ed) =>
            ed.id !== eduId ? ed : { ...ed, [field]: value },
          ),
        };
      });
    },
    [],
  );

  const addEducation = useCallback(() => {
    setStructured((cur) =>
      cur ? { ...cur, education: [...cur.education, blankEducation()] } : cur,
    );
  }, []);

  const removeEducation = useCallback((eduId: string) => {
    setStructured((cur) =>
      cur
        ? { ...cur, education: cur.education.filter((ed) => ed.id !== eduId) }
        : cur,
    );
  }, []);

  const moveEducation = useCallback((eduId: string, dir: -1 | 1) => {
    setStructured((cur) => {
      if (!cur) return cur;
      const idx = cur.education.findIndex((ed) => ed.id === eduId);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= cur.education.length) return cur;
      const education = [...cur.education];
      [education[idx], education[to]] = [education[to], education[idx]];
      return { ...cur, education };
    });
  }, []);

  // Extra (unclassified) sections — heading + raw markdown, preserved
  // verbatim by lib/resumeStructure. Editable as plain text.
  const updateExtraSection = useCallback(
    (extraId: string, patch: { heading?: string; markdown?: string }) => {
      setStructured((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          extraSections: cur.extraSections.map((x) =>
            x.id !== extraId ? x : { ...x, ...patch },
          ),
        };
      });
    },
    [],
  );

  const removeExtraSection = useCallback((extraId: string) => {
    setStructured((cur) =>
      cur
        ? {
            ...cur,
            extraSections: cur.extraSections.filter((x) => x.id !== extraId),
          }
        : cur,
    );
  }, []);

  async function suggestSkills() {
    setSkillsBusy(true);
    try {
      const res = await rewrite.mutateAsync({ mode: 'skills' });
      setSkillSuggestions(res.skills ?? []);
    } catch {
      /* non-fatal */
    } finally {
      setSkillsBusy(false);
    }
  }

  // ── loading / error / not-found ──
  if (isError) {
    return (
      <EditorMessage
        title={t('state.error_title')}
        body={t('state.error_body')}
        action={{ label: t('state.back'), onClick: () => router.push('/resumes') }}
      />
    );
  }
  if (isLoading || !structured || !resume) {
    return <EditorMessage title={t('state.loading')} />;
  }

  return (
    // Break out of .main-inner padding so the split pane is full-bleed like the
    // prototype. The (auth) main column is the positioning context.
    <div style={{ margin: '-28px -32px -80px' }}>
      <div className="rb-editor">
        <EditorToolbar
          name={resumeName}
          onRename={setResumeName}
          saveState={saveState}
          strength={strength}
          report={analysis}
          onJumpToIssue={jumpToIssue}
          coachOpen={coachOpen}
          onToggleCoach={() => setCoachOpen((o) => !o)}
          onDownload={() => setDownloadOpen(true)}
          onTailor={() => setTailorOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onBack={() => router.push('/resumes')}
        />

        <div className="rb-split">
          {/* LEFT — structured editor */}
          <div className="rb-edit-pane">
            {/* Identity */}
            <EditorSection eyebrow="01" title={t('section.identity')} anchorId="identity">
              <div className="rb-field-grid">
                <RbField
                  label={t('field.full_name')}
                  value={structured.contact.fullName}
                  onChange={(v) =>
                    updateStructured({
                      ...structured,
                      contact: { ...structured.contact, fullName: v },
                    })
                  }
                />
                <RbField
                  label={t('field.title')}
                  value={structured.targetTitle}
                  ai
                  aiLabel={t('field.ai')}
                  onChange={(v) =>
                    updateStructured({ ...structured, targetTitle: v })
                  }
                />
                <RbField
                  label={t('field.email')}
                  value={structured.contact.email}
                  onChange={(v) =>
                    updateStructured({
                      ...structured,
                      contact: { ...structured.contact, email: v },
                    })
                  }
                />
                <RbField
                  label={t('field.phone')}
                  value={structured.contact.phone}
                  onChange={(v) =>
                    updateStructured({
                      ...structured,
                      contact: { ...structured.contact, phone: v },
                    })
                  }
                />
                <RbField
                  label={t('field.location')}
                  value={structured.contact.location}
                  onChange={(v) =>
                    updateStructured({
                      ...structured,
                      contact: { ...structured.contact, location: v },
                    })
                  }
                />
                <RbField
                  label={t('field.links')}
                  value={structured.contact.links.join(' · ')}
                  onChange={(v) =>
                    updateStructured({
                      ...structured,
                      contact: {
                        ...structured.contact,
                        links: v
                          .split(/\s*·\s*/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    })
                  }
                />
              </div>
            </EditorSection>

            {/* Summary */}
            <EditorSection eyebrow="02" title={t('section.summary')} anchorId="summary">
              <SummaryEditor
                value={structured.summary}
                onChange={(v) => updateStructured({ ...structured, summary: v })}
                runRewrite={(body) => rewrite.mutateAsync(body)}
              />
            </EditorSection>

            {/* Experience */}
            <EditorSection
              eyebrow="03"
              title={t('section.experience')}
              subtitle={t('experience.hint')}
              addLabel={t('experience.add_role')}
              onAdd={addExperience}
              anchorId="experience"
            >
              {structured.experiences.map((e, expIdx) => (
                <div key={e.id} id={`exp-${e.id}`} className="rb-exp">
                  <div className="rb-exp-head">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <input
                        className="rb-exp-title"
                        value={e.title}
                        placeholder={t('experience.title_placeholder')}
                        onChange={(ev) =>
                          updateExperienceField(e.id, 'title', ev.target.value)
                        }
                        style={inlineInput()}
                      />
                      <div className="rb-exp-co">
                        <input
                          value={e.company}
                          placeholder={t('experience.company_placeholder')}
                          onChange={(ev) =>
                            updateExperienceField(
                              e.id,
                              'company',
                              ev.target.value,
                            )
                          }
                          style={{ ...inlineInput(), fontWeight: 600, width: 'auto' }}
                        />
                        {' · '}
                        <input
                          value={e.location}
                          placeholder={t('experience.location_placeholder')}
                          onChange={(ev) =>
                            updateExperienceField(
                              e.id,
                              'location',
                              ev.target.value,
                            )
                          }
                          style={{ ...inlineInput(), width: 'auto' }}
                        />
                        {' · '}
                        <span className="rb-exp-when">
                          <input
                            value={e.startDate}
                            placeholder={t('experience.start_placeholder')}
                            onChange={(ev) =>
                              updateExperienceField(
                                e.id,
                                'startDate',
                                ev.target.value,
                              )
                            }
                            style={{ ...inlineInput(), width: 70 }}
                          />
                          {' — '}
                          <input
                            value={e.endDate}
                            placeholder={t('experience.end_placeholder')}
                            onChange={(ev) =>
                              updateExperienceField(
                                e.id,
                                'endDate',
                                ev.target.value,
                              )
                            }
                            style={{ ...inlineInput(), width: 70 }}
                          />
                        </span>
                      </div>
                    </div>
                    <EntryControls
                      onMoveUp={
                        expIdx > 0 ? () => moveExperience(e.id, -1) : undefined
                      }
                      onMoveDown={
                        expIdx < structured.experiences.length - 1
                          ? () => moveExperience(e.id, 1)
                          : undefined
                      }
                      onRemove={() => removeExperience(e.id)}
                      moveUpLabel={t('entry.move_up')}
                      moveDownLabel={t('entry.move_down')}
                      removeLabel={t('entry.remove')}
                    />
                  </div>
                  <div className="rb-bullets">
                    {e.bullets.map((b, i) => (
                      <BulletRow
                        key={`${e.id}-${i}`}
                        text={b}
                        onAccept={(text) => updateBullet(e.id, i, text)}
                        onChange={(text) => updateBullet(e.id, i, text)}
                        onAddBelow={() => insertBulletBelow(e.id, i)}
                        onRemove={(opts) => removeBullet(e.id, i, opts)}
                        onMoveUp={i > 0 ? () => moveBullet(e.id, i, -1) : undefined}
                        onMoveDown={
                          i < e.bullets.length - 1
                            ? () => moveBullet(e.id, i, 1)
                            : undefined
                        }
                        requestFocus={
                          pendingBulletFocusRef.current?.expId === e.id &&
                          pendingBulletFocusRef.current?.idx === i
                        }
                        onFocusHandled={() => {
                          pendingBulletFocusRef.current = null;
                        }}
                        runRewrite={(body) => rewrite.mutateAsync(body)}
                        targetJobId={resume.targetJobId}
                      />
                    ))}
                    <button
                      type="button"
                      className="rb-add-bullet"
                      onClick={() => addBullet(e.id)}
                    >
                      {t('experience.add_bullet')}
                    </button>
                  </div>
                </div>
              ))}

              {/* Young-career helpers */}
              <div className="rb-young">
                <div className="rb-young-head">
                  <span className="rb-ai-spark">✦</span>
                  {t('young.head')}
                </div>
                <div className="rb-young-grid">
                  {YOUNG_HELPERS.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="rb-young-chip"
                      onClick={addExperience}
                    >
                      <span className="rb-young-ic">{h.icon}</span>
                      <div>
                        <div className="rb-young-lbl">
                          {t(`young.${h.id}.label`)}
                        </div>
                        <div className="rb-young-desc">
                          {t(`young.${h.id}.desc`)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </EditorSection>

            {/* Education */}
            <EditorSection
              eyebrow="04"
              title={t('section.education')}
              addLabel={t('education.add')}
              onAdd={addEducation}
              anchorId="education"
            >
              {structured.education.map((ed, eduIdx) => (
                <div key={ed.id} className="rb-edu">
                  <div className="rb-edu-head">
                    <input
                      className="rb-edu-school"
                      value={ed.school}
                      placeholder={t('education.school_placeholder')}
                      onChange={(ev) =>
                        updateEducationField(ed.id, 'school', ev.target.value)
                      }
                      style={inlineInput()}
                    />
                    <EntryControls
                      onMoveUp={
                        eduIdx > 0 ? () => moveEducation(ed.id, -1) : undefined
                      }
                      onMoveDown={
                        eduIdx < structured.education.length - 1
                          ? () => moveEducation(ed.id, 1)
                          : undefined
                      }
                      onRemove={() => removeEducation(ed.id)}
                      moveUpLabel={t('entry.move_up')}
                      moveDownLabel={t('entry.move_down')}
                      removeLabel={t('entry.remove')}
                    />
                    <span className="rb-edu-when">
                      <input
                        value={ed.startDate}
                        placeholder={t('experience.start_placeholder')}
                        onChange={(ev) =>
                          updateEducationField(
                            ed.id,
                            'startDate',
                            ev.target.value,
                          )
                        }
                        style={{ ...inlineInput(), width: 60 }}
                      />
                      {ed.endDate || ed.startDate ? ' — ' : ''}
                      <input
                        value={ed.endDate}
                        placeholder={t('experience.end_placeholder')}
                        onChange={(ev) =>
                          updateEducationField(ed.id, 'endDate', ev.target.value)
                        }
                        style={{ ...inlineInput(), width: 60 }}
                      />
                    </span>
                  </div>
                  <input
                    className="rb-edu-degree"
                    value={ed.degree}
                    placeholder={t('education.degree_placeholder')}
                    onChange={(ev) =>
                      updateEducationField(ed.id, 'degree', ev.target.value)
                    }
                    style={{ ...inlineInput(), width: '100%' }}
                  />
                  {ed.bullets.length ? (
                    <div className="rb-edu-detail">{ed.bullets.join(' ')}</div>
                  ) : null}
                </div>
              ))}
            </EditorSection>

            {/* Skills */}
            <EditorSection
              eyebrow="05"
              title={t('section.skills')}
              aiLabel={t('skills.suggest')}
              aiBusy={skillsBusy}
              onAi={suggestSkills}
              anchorId="skills"
            >
              <SkillsEditor
                skills={structured.skills}
                onChange={(next) =>
                  updateStructured({ ...structured, skills: next })
                }
                suggestions={skillSuggestions}
                onClearSuggestions={() => setSkillSuggestions([])}
              />
            </EditorSection>

            {/* Extra sections — unclassified `##` blocks (Projects,
                Certifications…) preserved from the source markdown. Edited as
                heading + raw markdown; full structural editing not needed to
                keep them lossless. */}
            {structured.extraSections.length > 0 ? (
              <EditorSection
                eyebrow="06"
                title={t('section.other')}
                subtitle={t('extra.hint')}
                anchorId="extra-sections"
              >
                {structured.extraSections.map((x) => (
                  <div key={x.id} className="rb-extra">
                    <div className="rb-extra-head">
                      <input
                        className="rb-extra-heading"
                        value={x.heading}
                        placeholder={t('extra.heading_placeholder')}
                        onChange={(ev) =>
                          updateExtraSection(x.id, { heading: ev.target.value })
                        }
                      />
                      <EntryControls
                        onRemove={() => removeExtraSection(x.id)}
                        removeLabel={t('entry.remove')}
                      />
                    </div>
                    <textarea
                      className="rb-textarea rb-extra-body"
                      value={x.markdown}
                      placeholder={t('extra.body_placeholder')}
                      rows={Math.min(10, x.markdown.split('\n').length + 1)}
                      onChange={(ev) =>
                        updateExtraSection(x.id, { markdown: ev.target.value })
                      }
                    />
                  </div>
                ))}
              </EditorSection>
            ) : null}
          </div>

          {/* RIGHT — paper preview */}
          <div className="rb-preview-pane">
            <div className="rb-preview-bar">
              <span className="rb-preview-lbl">{t('preview.label')}</span>
              <div className="rb-zoom">
                <span>{t('preview.page')}</span>
              </div>
            </div>
            <div className="rb-paper-wrap">
              <ResumePaper resume={structured} />
            </div>
          </div>
        </div>
      </div>

      {/* Floating coach */}
      {coachOpen ? (
        <CoachPanel
          tips={coachData?.tips ?? []}
          onClose={() => setCoachOpen(false)}
        />
      ) : null}

      {/* Tailor modal */}
      {tailorOpen ? (
        <TailorModal
          resumeId={id}
          resumeName={resumeName}
          onClose={() => setTailorOpen(false)}
          onCreated={(variantId) => {
            setTailorOpen(false);
            router.push(`/resumes/${variantId}`);
          }}
        />
      ) : null}

      {/* Download modal */}
      {downloadOpen ? (
        <DownloadModal
          resumeId={id}
          resumeName={resumeName}
          resumeMarkdown={serializeResumeMarkdown(structured)}
          onClose={() => setDownloadOpen(false)}
        />
      ) : null}

      {/* Delete confirm — typed-confirm; on success returns to the library. */}
      <DeleteResumeConfirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        resumeName={resumeName}
        labels={{
          title: t('delete.title'),
          body: t('delete.body'),
          inputLabel: t('delete.input_label'),
          mismatchHint: t('delete.mismatch_hint'),
          cancel: t('delete.cancel'),
          confirm: t('delete.confirm'),
          confirming: t('delete.confirming'),
        }}
        onConfirm={async () => {
          await del.mutateAsync(id);
          setDeleteOpen(false);
          router.push('/resumes');
        }}
      />
    </div>
  );
}

/** Quiet hover-revealed entry controls (reorder + remove) for experience /
 *  education / extra-section cards. Buttons only render for legal moves. */
function EntryControls({
  onMoveUp,
  onMoveDown,
  onRemove,
  moveUpLabel,
  moveDownLabel,
  removeLabel,
}: {
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
  moveUpLabel?: string;
  moveDownLabel?: string;
  removeLabel: string;
}) {
  return (
    <span className="rb-entry-actions">
      {moveUpLabel ? (
        <button
          type="button"
          className="rb-entry-btn"
          title={moveUpLabel}
          aria-label={moveUpLabel}
          disabled={!onMoveUp}
          onClick={onMoveUp}
        >
          ↑
        </button>
      ) : null}
      {moveDownLabel ? (
        <button
          type="button"
          className="rb-entry-btn"
          title={moveDownLabel}
          aria-label={moveDownLabel}
          disabled={!onMoveDown}
          onClick={onMoveDown}
        >
          ↓
        </button>
      ) : null}
      <button
        type="button"
        className="rb-entry-btn"
        title={removeLabel}
        aria-label={removeLabel}
        onClick={onRemove}
      >
        ✕
      </button>
    </span>
  );
}

/** Inline-edit input that visually inherits the surrounding text style. */
function inlineInput(): React.CSSProperties {
  return {
    background: 'transparent',
    border: 0,
    outline: 'none',
    color: 'inherit',
    font: 'inherit',
    padding: 0,
    width: '100%',
  };
}

function EditorMessage({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      style={{
        minHeight: '50vh',
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
      }}
    >
      <div>
        <p style={{ fontSize: 15, color: 'var(--text)', fontWeight: 600 }}>
          {title}
        </p>
        {body ? (
          <p style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 6 }}>
            {body}
          </p>
        ) : null}
        {action ? (
          <button
            type="button"
            className="btn"
            style={{ marginTop: 16 }}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
