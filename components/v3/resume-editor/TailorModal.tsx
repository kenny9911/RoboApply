'use client';

// TailorModal — the "Tailor for a job" flow (.rb-modal). Source:
// RoboApply_V3/resume-editor.jsx TailorModal. Four steps:
//   pick      → choose a job from your matches (search.run) OR paste a JD
//   analyzing → animated step list while resumes.tailorDiff runs
//   review    → before/after match score + per-change toggles
//   done      → resumes.create({ kind:'tailored_for_jd' }) materialized
//
// The diff comes from `resumes.tailorDiff` (does NOT create the variant). On
// apply we create the tailored variant via `resumes.create` and hand the new
// id back so the page can offer "Open tailored copy".
//
// Modal panel uses a LITERAL solid background (CLAUDE.md rule) — the .rb-modal
// backdrop keeps its dim tint.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Markdown, IconX, IconCheck, IconBolt, IconArrow } from '../primitives';
import { useResumeTailorDiff, useResumeTailorApply } from '../../../hooks/useResumes';
import { useJobSearch } from '../../../hooks/useJobSearch';
import type {
  RATailorChange,
  RATailorDiff,
  RAJobListItem,
} from '../../../lib/api/v2/types';

type Step = 'pick' | 'analyzing' | 'review' | 'done';

interface Props {
  resumeId: string;
  resumeName: string;
  onClose: () => void;
  /** Called once a tailored variant is created — lets the page route to it. */
  onCreated: (variantId: string) => void;
}

// Solid panel bg. Theme-aware var(--surface) — flips white in light, dark in dark (the bare token is on :root, so it never bleeds; the .rb-modal-card class also paints it).
const PANEL_BG = 'var(--surface)';

export function TailorModal({ resumeId, resumeName, onClose, onCreated }: Props) {
  const t = useTranslations('resumeEditor');
  const tailorDiff = useResumeTailorDiff(resumeId);
  const applyMut = useResumeTailorApply(resumeId);
  const { data: searchData, isLoading: jobsLoading } = useJobSearch({
    sortBy: 'match_desc',
    limit: 6,
  });

  const [step, setStep] = useState<Step>('pick');
  const [job, setJob] = useState<{
    id: string | null;
    company: string;
    role: string;
  } | null>(null);
  const [diff, setDiff] = useState<RATailorDiff | null>(null);
  // The agent's tailored markdown from the preview — persisted on Apply, so the
  // saved variant is exactly what was shown (no second LLM re-tailor).
  const [tailoredMarkdown, setTailoredMarkdown] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const jobs: RAJobListItem[] = searchData?.jobs ?? [];

  async function start(picked: {
    id: string | null;
    company: string;
    role: string;
    jdText?: string;
  }) {
    setJob(picked);
    setStep('analyzing');
    setError(false);
    try {
      const res = await tailorDiff.mutateAsync(
        picked.id
          ? { targetJobId: picked.id }
          : { jdText: picked.jdText ?? '' },
      );
      setDiff(res.diff);
      setTailoredMarkdown(res.tailoredResumeMarkdown ?? null);
      setAccepted(new Set(res.diff.changes.map((c) => c.id)));
      setStep('review');
    } catch {
      setError(true);
      setStep('pick');
    }
  }

  function toggle(id: string) {
    setAccepted((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    if (!diff || !tailoredMarkdown) return;
    setError(false);
    try {
      // Persist exactly the previewed tailored markdown, honoring the user's
      // per-change toggles — for BOTH a real job and a pasted JD, with no
      // second LLM call (and no double charge). Deselected reversible changes
      // are reverted server-side from `acceptedChangeIds`.
      const res = await applyMut.mutateAsync({
        tailoredResumeMarkdown: tailoredMarkdown,
        changes: diff.changes,
        acceptedChangeIds: [...accepted],
        targetJobId: diff.jobId ?? undefined,
        name: `${resumeName} · ${diff.companyName}`,
      });
      setCreatedId(res.resume.id);
      setStep('done');
    } catch {
      setError(true);
    }
  }

  return (
    <div className="rb-modal" onClick={onClose}>
      <div
        className="rb-modal-card big"
        style={{ background: PANEL_BG }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rb-modal-head">
          <div>
            <div
              className="iv-step-num"
              style={{ display: 'inline-block', marginBottom: 8 }}
            >
              {t('tailor.eyebrow')}
            </div>
            <h2 className="rb-modal-title">
              {step === 'pick' ? t('tailor.title_pick') : null}
              {step === 'analyzing' ? (
                <>
                  {t('tailor.title_analyzing_lead')}{' '}
                  <em>{t('tailor.title_analyzing_accent')}</em>{' '}
                  {t('tailor.title_analyzing_after')}
                </>
              ) : null}
              {step === 'review' ? (
                <>
                  {t('tailor.title_review_lead')}{' '}
                  <em>{job?.company}</em>
                </>
              ) : null}
              {step === 'done' ? t('tailor.title_done') : null}
            </h2>
          </div>
          <button
            type="button"
            className="iv-coach-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="rb-modal-body">
          {error ? (
            <p style={{ fontSize: 13, color: 'var(--warn)', marginBottom: 14 }}>
              {t('tailor.error')}
            </p>
          ) : null}

          {step === 'pick' ? (
            <>
              <div>
                <div className="rb-tailor-source-lbl">
                  {t('tailor.source_label')}
                </div>
                <div className="rb-tailor-jobs">
                  {jobsLoading ? (
                    <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                      {t('tailor.loading_jobs')}
                    </p>
                  ) : jobs.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                      {t('tailor.no_jobs')}
                    </p>
                  ) : (
                    jobs.map((j) => (
                      <button
                        key={j.id}
                        type="button"
                        className="rb-tailor-job"
                        onClick={() =>
                          start({
                            id: j.id,
                            company: j.companyName,
                            role: j.title,
                          })
                        }
                      >
                        <div className="logo" data-color={0}>
                          {j.companyName.charAt(0).toUpperCase()}
                        </div>
                        <div className="rb-tailor-job-body">
                          <div className="rb-tailor-job-title">{j.title}</div>
                          <div className="rb-tailor-job-co">{j.companyName}</div>
                        </div>
                        <div className="rb-tailor-job-match">
                          <span className="rb-tailor-match-num">
                            {j.matchScoreCached != null
                              ? Math.round(j.matchScoreCached)
                              : '—'}
                          </span>
                          <span className="rb-tailor-match-lbl">
                            {t('tailor.fit')}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="rb-tailor-or">{t('tailor.or')}</div>
              <button
                type="button"
                className="rb-tailor-paste-toggle"
                onClick={() => setPasteOpen((o) => !o)}
              >
                {pasteOpen ? '−' : '+'} {t('tailor.paste_toggle')}
              </button>
              {pasteOpen ? (
                <div style={{ marginTop: 12 }}>
                  <textarea
                    className="rb-textarea"
                    placeholder={t('tailor.paste_placeholder')}
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    rows={5}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    style={{ marginTop: 10 }}
                    disabled={pasted.trim().length < 30}
                    onClick={() =>
                      start({
                        id: null,
                        company: t('tailor.pasted_company'),
                        role: t('tailor.pasted_role'),
                        jdText: pasted,
                      })
                    }
                  >
                    {t('tailor.analyze_paste')}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {step === 'analyzing' ? (
            <div className="rb-analyzing">
              <div className="rb-analyzing-orb">
                <div className="iv-coach-orb" style={{ width: 60, height: 60 }} />
              </div>
              <div className="rb-analyzing-steps">
                {[
                  'analyzing.read_jd',
                  'analyzing.cross_check',
                  'analyzing.find_gaps',
                  'analyzing.draft',
                  'analyzing.rescore',
                ].map((key, i) => (
                  <div
                    key={key}
                    className="rb-analyzing-row"
                    style={{ animationDelay: `${i * 0.45}s` }}
                  >
                    <div className="ic">
                      <IconCheck size={12} />
                    </div>
                    <div>{t(`tailor.${key}`)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {step === 'review' && diff ? (
            <>
              <div className="rb-tailor-summary">
                <div className="rb-tailor-summary-meta">
                  <div className="rb-tailor-summary-co">
                    <div className="logo" data-color={0}>
                      {diff.companyName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="rb-tailor-summary-title">
                        {diff.roleTitle}
                      </div>
                      <div className="rb-tailor-summary-sub">
                        {diff.companyName}
                      </div>
                    </div>
                  </div>
                  <div className="rb-tailor-score-shift">
                    <div className="rb-tailor-score-before">
                      <span className="rb-tailor-score-num">
                        {diff.matchBefore}
                      </span>
                      <span className="rb-tailor-score-lbl">
                        {t('tailor.before')}
                      </span>
                    </div>
                    <div className="rb-tailor-arrow">→</div>
                    <div className="rb-tailor-score-after">
                      <span className="rb-tailor-score-num">
                        {diff.matchAfter}
                      </span>
                      <span className="rb-tailor-score-lbl">
                        {t('tailor.after')}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="rb-tailor-summary-note">
                  {t('tailor.note', { count: diff.changes.length })}
                </div>
              </div>

              <div className="rb-tailor-changes">
                {diff.changes.map((c) => (
                  <TailorChangeRow
                    key={c.id}
                    change={c}
                    on={accepted.has(c.id)}
                    onToggle={() => toggle(c.id)}
                  />
                ))}
              </div>
            </>
          ) : null}

          {step === 'done' ? (
            <div style={{ textAlign: 'center', padding: '30px 20px' }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: 'var(--ok)',
                  color: 'var(--bg)',
                  display: 'grid',
                  placeItems: 'center',
                  margin: '0 auto 16px',
                  boxShadow: '0 0 30px rgba(74, 222, 128, 0.4)',
                }}
              >
                <IconCheck size={28} />
              </div>
              <h3
                style={{
                  fontSize: 22,
                  fontWeight: 600,
                  margin: '0 0 6px',
                  letterSpacing: '-0.02em',
                }}
              >
                {t('tailor.done_title')}
              </h3>
              <p
                style={{
                  fontSize: 13.5,
                  color: 'var(--text-2)',
                  maxWidth: 400,
                  margin: '0 auto 6px',
                }}
              >
                {createdId
                  ? t('tailor.done_body', {
                      name: `${resumeName} · ${job?.company ?? ''}`,
                    })
                  : t('tailor.done_body_paste')}
              </p>
            </div>
          ) : null}
        </div>

        <div className="rb-modal-foot">
          {step === 'pick' ? (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('tailor.pick_hint')}
              </span>
            </>
          ) : null}
          {step === 'review' ? (
            <>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setStep('pick')}
              >
                {t('tailor.pick_different')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={apply}
                disabled={applyMut.isPending || !tailoredMarkdown}
              >
                <IconBolt size={13} />{' '}
                {t('tailor.apply', { count: accepted.size })}
              </button>
            </>
          ) : null}
          {step === 'done' ? (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('tailor.back_to_editor')}
              </button>
              {createdId ? (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => onCreated(createdId)}
                >
                  {t('tailor.open_copy')} <IconArrow size={13} />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TailorChangeRow({
  change,
  on,
  onToggle,
}: {
  change: RATailorChange;
  on: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('resumeEditor');
  return (
    <div className={`rb-change ${on ? 'on' : 'off'}`}>
      <button type="button" className="rb-change-toggle" onClick={onToggle}>
        <span className={`rb-change-check ${on ? 'on' : ''}`}>
          {on ? <IconCheck size={10} /> : null}
        </span>
      </button>
      <div className="rb-change-body">
        <div className="rb-change-head">
          <span className={`rb-change-tag rb-change-tag-${change.kind}`}>
            {t(`tailor.kind.${change.kind}`)}
          </span>
          <span className="rb-change-section">{change.section}</span>
        </div>
        <div className="rb-change-label">{change.label}</div>
        {change.kind === 'rewrite' ? (
          <div className="rb-change-diff">
            <div className="rb-change-before">
              <span className="rb-change-diff-lbl">{t('tailor.before')}</span>
              {change.before}
            </div>
            <div className="rb-change-after">
              <span className="rb-change-diff-lbl">{t('tailor.after')}</span>
              {change.after}
            </div>
          </div>
        ) : null}
        {change.kind === 'add' && change.added ? (
          <div className="rb-change-add">
            {change.added.map((a, i) => (
              <span
                key={i}
                className="rb-skill"
                style={{
                  background: 'var(--accent-soft)',
                  color: 'var(--accent-text)',
                  borderColor: 'var(--accent-text)',
                }}
              >
                + {a}
              </span>
            ))}
          </div>
        ) : null}
        {(change.kind === 'reorder' || change.kind === 'trim') &&
        change.detail ? (
          <div className="rb-change-detail">{change.detail}</div>
        ) : null}
      </div>
    </div>
  );
}
