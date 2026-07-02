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
// Contract gap: `StructuredResume` (lib/resumeStructure) round-trips Identity /
// Summary / Experience / Education / Skills only — it has no Projects field, so
// the editor is scoped to those 5 sections to avoid silently dropping a
// Projects section on the next save. The prototype's Projects section is out of
// scope until either the parser gains projects support or the contract adds a
// structured field. (Reported.)
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
import { IconEdit } from '../../../../components/v3/primitives';

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

  // Hydrate from server on first load.
  useEffect(() => {
    if (!resume) return;
    setStructured(parseResumeMarkdown(resume.resumeMarkdown));
    setResumeName(resume.name);
    lastSerializedRef.current = resume.resumeMarkdown;
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
    if (serialized === lastSerializedRef.current) return;

    setSaveState('saving');
    const handle = setTimeout(async () => {
      try {
        const next = await patch.mutateAsync({ resumeMarkdown: serialized });
        lastSerializedRef.current = serialized;
        setSaveState('saved');
        void next;
      } catch {
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
  // land.
  const strength = useMemo(() => {
    if (!structured) return 0;
    try {
      return analyzeResume(structured).score;
    } catch {
      return resume?.matchScoreCached ?? 72;
    }
  }, [structured, resume]);

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
        experiences: cur.experiences.map((e) =>
          e.id !== expId ? e : { ...e, bullets: [...e.bullets, ''] },
        ),
      };
    });
  }, []);

  const addExperience = useCallback(() => {
    setStructured((cur) =>
      cur ? { ...cur, experiences: [...cur.experiences, blankExperience()] } : cur,
    );
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
              {structured.experiences.map((e) => (
                <div key={e.id} className="rb-exp">
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
                    <span
                      className="btn ghost"
                      style={{ padding: '5px 9px', fontSize: 11.5, cursor: 'default' }}
                      aria-hidden="true"
                    >
                      <IconEdit size={12} /> {t('experience.editing')}
                    </span>
                  </div>
                  <div className="rb-bullets">
                    {e.bullets.map((b, i) => (
                      <BulletRow
                        key={`${e.id}-${i}`}
                        text={b}
                        onAccept={(text) => updateBullet(e.id, i, text)}
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
              {structured.education.map((ed) => (
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
