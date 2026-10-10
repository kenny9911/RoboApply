'use client';

// /resumes/[id] — V3 Resume editor (Lane F). Replaces the V2 builder page.
//
// Source prototype: RoboApply_V3/resume-editor.jsx (whole). Split-pane:
//   left  = structured edit pane (Identity / Summary / Experience / Education /
//           Skills), with inline per-bullet AI + a 3-option summary rewrite +
//           AI skill suggestions
//   right = live "paper" preview that re-renders as you type
// Plus a floating Coach rail (cycling tips), the Tailor sheet (tailor
// sessions: pick a saved job or paste the posting → setup → Verify details →
// Use this resume), and a Download modal.
//
// Data + state model:
//   • `useResume(id)` (existing) → seeds local `structured` parsed from
//     `resume.resumeMarkdown` via lib/resumeStructure (CLIENT-SIDE markdown↔
//     structure — RAResumeVariant carries no structured field; see contract
//     note below).
//   • All edits mutate `structured`; the preview re-renders live.
//   • A 1.2s debounce re-serializes `structured` → markdown and PATCHes
//     (`usePatchResumeMutation`) only when the USER changed something
//     (hooks/resume/useEditorAutosave: compared with what the loaded resume
//     serializes to, so opening an upload never rewrites it).
//   • Inline AI: `useResumeRewrite` (bullet / summary / skills).
//   • Tailor: `<TailorSheet>` (components/features/tailor; one `tailor` credit per run).
//   • Coach: `useResumeCoachTips`.
//
// Sections: Identity / Summary / Experience / Education / Skills are fully
// structured; any other `##` section (Projects, Certifications, Languages…)
// round-trips through `StructuredResume.extraSections` and renders below as
// an editable heading + raw-markdown card — nothing is dropped on save.
//
// Autosave rehydration: `usePatchResumeMutation.onSuccess` writes the PATCH
// response back into the detail cache, which changes `resume` identity. The
// hydration in useEditorAutosave therefore guards: it only re-parses server
// markdown when it differs from what this editor last sent (first load /
// external change) — an autosave echo never clobbers in-flight keystrokes or
// remounts rows.
//
// WP-65 (preview pane): fit to one page (GoApply: 1–2 pages) with undo, the
// section order, the GoApply personal details (籍贯 / 政治面貌) and the device
// photo — placed by the export renderer only, never in the resume text — and
// "Ask the Assistant about this resume". The brand's details / photo / page
// rules come from GET /builder/config.
//
// Layout: the (auth) layout wraps children in `.main-inner` (padded, max-width
// 1180). The editor is a full-bleed split, so we break out of that padding with
// a negative-margin wrapper that spans the viewport width of the main column.

import {
  Suspense,
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
  useResumeList,
  usePatchResumeMutation,
  useResumeRewrite,
  useResumeCoachTips,
  useDeleteResumeMutation,
  usePatchResumeLayoutMutation,
} from '../../../../hooks/useResumes';
import {
  AskAssistantButton,
  FitToPageControl,
  LayoutPanel,
  ResumeDetailsPanel,
  SectionOrderPanel,
  docLanguageOf,
  layoutPatch,
  personalLineFor,
  resolveLayout,
} from '../../../../components/features/resume';
import { useBuilderConfig } from '../../../../hooks/resume/useResumeBuilder';
import { useResumePhoto } from '../../../../hooks/resume/useResumePhoto';
import { TailorLaunchHost, TailorSheet } from '../../../../components/features/tailor';
import { DeleteResumeConfirm } from '../../../../components/resumes/DeleteResumeConfirm';
import layoutStyles from '../../../../components/features/resume/ResumeHub.module.css';
import {
  serializeResumeMarkdown,
  blankExperience,
  blankEducation,
  type StructuredResume,
  type StructuredExperience,
  type StructuredEducation,
} from '../../../../lib/resumeStructure';
import { analyzeResume, resumePlaceholders } from '../../../../lib/resumeAnalyzer';
import { useLatestResumeCheck } from '../../../../hooks/resume/useResumeCheck';
import { useEditorAutosave } from '../../../../hooks/resume/useEditorAutosave';
import { useCreditGate } from '../../../../hooks/shared/useCreditGate';
import { CreditNotice } from '../../../../components/v3/primitives';
import {
  EditorToolbar,
  EditorSection,
  RbField,
  SummaryEditor,
  BulletRow,
  SkillsEditor,
  ResumePaper,
  CoachPanel,
  DownloadModal,
  YOUNG_HELPERS,
} from '../../../../components/v3/resume-editor';

export default function ResumeEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const t = useTranslations('resume');
  const router = useRouter();

  const { data: resume, isLoading, isError } = useResume(id);
  const patch = usePatchResumeMutation(id);
  const rewrite = useResumeRewrite(id);
  // AI consent (TASK_PLAN.md §2.2): the server reports whether AI may run for
  // this user; AI actions hide only once it says no (it refuses them anyway).
  const resumeCheck = useLatestResumeCheck(id);
  const aiEnabled = resumeCheck.data?.aiAvailable !== false;
  const del = useDeleteResumeMutation();
  const { data: coachData } = useResumeCoachTips(id);
  const layoutMut = usePatchResumeLayoutMutation(id);
  // WP-36b: template / page / spacing / accent / date format, saved per resume.
  const defaultPage = resume?.defaultPage ?? 'letter';
  const layout = useMemo(() => resolveLayout(resume?.layout ?? null, defaultPage), [resume?.layout, defaultPage]);
  const tb = useTranslations('resumeBuilder.editor');
  // WP-65: per-brand details, photo and page count (GoApply: 籍贯 / 政治面貌, photo, up to 2 pages).
  const builderConfig = useBuilderConfig();
  const personalFields = builderConfig.data?.personalFields ?? [];
  const photoOffered = builderConfig.data?.photo.offered ?? false;
  const maxPages = builderConfig.data?.maxPages ?? 1;
  const photo = useResumePhoto(id);
  const placedPhoto = photoOffered && layout.photo ? photo.photo : null;

  const [resumeName, setResumeName] = useState('');
  const [coachOpen, setCoachOpen] = useState(true);
  const [tailorOpen, setTailorOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [skillSuggestions, setSkillSuggestions] = useState<string[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);

  // One-shot focus request for a freshly inserted bullet (consumed by
  // BulletRow's mount — a ref, so setting it never re-renders).
  const pendingBulletFocusRef = useRef<{ expId: string; idx: number } | null>(
    null,
  );

  // AI provenance (WP-36b): remember every AI-written text the editor was
  // offered; once one of them lands in the saved resume, the next save tells
  // the server, so exports carry the AI marks (CN-E-07). Skills shorter than
  // 4 characters are too common to attribute.
  const aiTextsRef = useRef<Set<string>>(new Set());
  const aiReportedRef = useRef(false);
  // Every inline AI edit (a bullet action, a summary rewrite, skill
  // suggestions) spends one `rewrite` credit on the server. The gate keeps
  // "N left" true, does not send a request that is known to have no credit,
  // and opens the out-of-credits sheet on a 402.
  const { run: spendRewrite, summary: rewriteCredits } = useCreditGate('rewrite');
  const runAiRewrite = useCallback(
    async (body: Parameters<typeof rewrite.mutateAsync>[0]) => {
      const spent = await spendRewrite(() => rewrite.mutateAsync(body));
      // The sheet explains; callers show their own "did not work" state.
      if (!spent.ok) throw new Error(spent.reason);
      const res = spent.value;
      const texts = [res.rewrite, ...(res.options ?? []).map((o) => o.text), ...(res.skills ?? [])];
      for (const text of texts) if (text && text.trim().length >= 4) aiTextsRef.current.add(text.trim());
      return res;
    },
    [rewrite, spendRewrite],
  );

  // Document state + debounced autosave (hooks/resume/useEditorAutosave): the
  // resume is saved only after the user changed it — opening an uploaded
  // resume never rewrites it.
  const saveMarkdown = useCallback(
    async (serialized: string) => {
      const aiLanded =
        !aiReportedRef.current && [...aiTextsRef.current].some((text) => serialized.includes(text));
      await patch.mutateAsync(aiLanded ? { resumeMarkdown: serialized, aiAssisted: true } : { resumeMarkdown: serialized });
      if (aiLanded) aiReportedRef.current = true;
    },
    [patch],
  );
  const { structured, setStructured, saveState, hydrations } = useEditorAutosave(resume, saveMarkdown);

  // The name follows the server on each hydration (first load, resume switch,
  // external change) — never on an autosave echo, which would undo typing.
  useEffect(() => {
    if (resume) setResumeName(resume.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on hydration, not on every refetch
  }, [hydrations]);

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

  // Lines that still carry a blank an AI suggestion left ("[X]", "[n=__]").
  const placeholderLines = useMemo(() => (structured ? resumePlaceholders(structured) : []), [structured]);

  // A tailored version with details still to check: where "Verify details"
  // opens for it. The hub list carries the session id (the detail view does
  // not); without it the link goes to the hub, which lists the same action.
  const unverifiedClaims = resume?.unverifiedClaims ?? 0;
  const hubList = useResumeList();
  const verifySessionId = unverifiedClaims > 0 ? (hubList.data?.resumes.find((r) => r.id === id)?.tailorSessionId ?? null) : null;
  const verifyHref = unverifiedClaims > 0 ? (verifySessionId ? `/resume?tailorSession=${encodeURIComponent(verifySessionId)}` : '/resume') : null;

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
      'section-projects': 'extra-sections',
    };
    const domId = anchor.startsWith('exp-') ? anchor : sectionMap[anchor];
    if (!domId) return;
    document
      .getElementById(domId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // /resume/[id]?focus=section-… (links from the resume check report): jump
  // once the structured editor has rendered.
  const focusHandledRef = useRef(false);
  useEffect(() => {
    if (focusHandledRef.current || !structured) return;
    focusHandledRef.current = true;
    const focus = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('focus');
    if (focus) window.setTimeout(() => jumpToIssue(focus), 0);
  }, [structured, jumpToIssue]);

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
      const res = await runAiRewrite({ mode: 'skills' });
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
        action={{ label: t('state.back'), onClick: () => router.push('/resume') }}
      />
    );
  }
  if (isLoading || !structured || !resume) {
    return <EditorMessage title={t('state.loading')} />;
  }

  return (
    // Break out of .main-inner padding so the split pane is full-bleed like the
    // prototype. The (auth) main column is the positioning context. The inset
    // follows the shell's padding per width (styles/v3-resume.css
    // .rb-editor-bleed): a fixed -32px was wider than the phone's 14px gutter
    // and scrolled the whole page sideways.
    <div className="rb-editor-bleed">
      {/* Runs the tailor flow for this resume from `?tailor=<jobId>` (WP-36a; mounted at the Wave 3 gate). */}
      <Suspense fallback={null}>
        <TailorLaunchHost resumeId={id} />
      </Suspense>
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
          onBack={() => router.push('/resume')}
          resumeId={id}
          aiEnabled={aiEnabled}
        />

        {/* Not ready to send yet: unchecked details of a tailored version, and blanks left by an AI suggestion. */}
        {verifyHref ? (
          <p className={layoutStyles.editorNotice} role="status" data-notice="unverified">
            <span>{t('export.unverified', { count: unverifiedClaims })}</span>
            <a className={layoutStyles.editorNoticeAction} href={verifyHref}>
              {t('export.verify_cta')}
            </a>
          </p>
        ) : null}
        {placeholderLines.length > 0 ? (
          <p className={layoutStyles.editorNotice} role="status" data-notice="placeholders">
            <span>{t('export.placeholders', { count: placeholderLines.length })}</span>
            <button type="button" className={layoutStyles.editorNoticeAction} onClick={() => jumpToIssue(placeholderLines[0]!.anchor)}>
              {t('export.placeholders_show')}
            </button>
          </p>
        ) : null}

        <div className="rb-split">
          {/* LEFT — structured editor */}
          <div className="rb-edit-pane">
            {/* The cost of an AI edit, before the click. */}
            {aiEnabled ? (
              <div className={layoutStyles.creditLine} data-credit="rewrite">
                <span>{t('ai_edit_cost')}</span>
                <CreditNotice bucket={rewriteCredits} />
              </div>
            ) : null}
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
                runRewrite={runAiRewrite}
                aiEnabled={aiEnabled}
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
                        runRewrite={runAiRewrite}
                        aiEnabled={aiEnabled}
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
              aiLabel={aiEnabled ? t('skills.suggest') : undefined}
              aiBusy={skillsBusy}
              onAi={aiEnabled ? suggestSkills : undefined}
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
            <FitToPageControl resumeId={id} maxPages={maxPages} photo={Boolean(placedPhoto)} />
            <div className="rb-preview-bar">
              <AskAssistantButton resumeId={id} enabled={aiEnabled} />
            </div>
            <details className={layoutStyles.layoutDetails}>
              <summary className={layoutStyles.layoutSummary}>{tb('order')}</summary>
              <SectionOrderPanel resume={structured} onChange={updateStructured} />
            </details>
            {personalFields.length > 0 || photoOffered ? (
              <details className={layoutStyles.layoutDetails}>
                <summary className={layoutStyles.layoutSummary}>{tb('details')}</summary>
                <ResumeDetailsPanel
                  layout={resume.layout}
                  personalFields={personalFields}
                  photoOffered={photoOffered}
                  photo={photo}
                  saving={layoutMut.isPending}
                  onPatch={(change) => layoutMut.mutate(change)}
                />
              </details>
            ) : null}
            <details className={layoutStyles.layoutDetails}>
              <summary className={layoutStyles.layoutSummary}>{t('layout.title')}</summary>
              <LayoutPanel
                value={layout}
                defaultPage={defaultPage}
                saving={layoutMut.isPending}
                error={layoutMut.isError}
                onChange={(change) => layoutMut.mutate(layoutPatch(change))}
              />
            </details>
            <div className="rb-paper-wrap">
              <ResumePaper
                resume={structured}
                layout={layout}
                personalLine={personalFields.length ? personalLineFor(resume.layout?.personal, docLanguageOf(layout.headingLanguage, resume.resumeMarkdown)) : null}
                photo={placedPhoto}
                photoAlt={tb('photoAlt')}
              />
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

      {/* Tailor (toolbar): the tailor-session flow. With no job in the URL the
          user first picks a saved job or pastes the posting (INT-10). */}
      {tailorOpen ? (
        <TailorSheet
          open
          resumeId={id}
          onClose={() => setTailorOpen(false)}
          onOpenResume={(variantId) => {
            setTailorOpen(false);
            router.push(`/resume/${variantId}`);
          }}
        />
      ) : null}

      {/* Download modal */}
      {downloadOpen ? (
        <DownloadModal
          resumeId={id}
          resumeName={resumeName}
          resumeMarkdown={serializeResumeMarkdown(structured)}
          unverifiedClaims={unverifiedClaims}
          verifyHref={verifyHref}
          placeholderLines={placeholderLines.map((l) => l.text)}
          aiAssisted={resume.aiAssisted ?? false}
          photo={placedPhoto}
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
          router.push('/resume');
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
        <p style={{ fontSize: 'var(--fs-body)', color: 'var(--text)', fontWeight: 600 }}>
          {title}
        </p>
        {body ? (
          <p style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-muted)', marginTop: 6 }}>
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
