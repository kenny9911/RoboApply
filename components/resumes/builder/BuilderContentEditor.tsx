'use client';

// BuilderContentEditor — the left pane "Content Editor" tab.
// Renders one collapsible BuilderSection per resume part:
//   Contact / Target Title / Professional Summary / Work Experience /
//   Education / Skills
//
// All state lives in the parent (BuilderPage); this component is fully
// controlled. Edits propagate immediately to the preview pane.

import { useRef, useState } from 'react';
import {
  PlusIcon,
  SparklesIcon,
  XMarkIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';

import { BuilderSection } from './BuilderSection';
import { BuilderBulletEditor } from './BuilderBulletEditor';
import { BuilderAddBullet, type BulletComposerHandle } from './BuilderAddBullet';
import {
  blankEducation,
  blankExperience,
  type StructuredEducation,
  type StructuredExperience,
  type StructuredResume,
} from '../../../lib/resumeStructure';
import { aiGenerateSummary, aiRewriteBullets } from '../../../lib/resumeAI';
import { cn } from '../../../lib/utils';

export interface ActiveBulletComposer {
  expId: string;
  handleRef: React.MutableRefObject<BulletComposerHandle | null>;
}

interface Props {
  resume: StructuredResume;
  onChange: (next: StructuredResume) => void;
  /** Called whenever a bullet composer opens or closes. The page uses this
   *  to swap the right pane between Preview ↔ BulletGuidancePanel. */
  onComposerChange?: (active: ActiveBulletComposer | null) => void;
}

function FieldRow({
  label,
  children,
  cols = 1,
}: {
  label: string;
  children: React.ReactNode;
  cols?: 1 | 2;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1',
        cols === 2 ? 'sm:flex-row sm:items-center sm:gap-4' : null,
      )}
    >
      <label className="text-xs font-medium uppercase tracking-wide text-ink-500 sm:w-32 sm:shrink-0">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-ink-line bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-300 transition-colors hover:border-ink-300 focus:border-accent-text focus:outline-none focus:shadow-focus';

export function BuilderContentEditor({
  resume,
  onChange,
  onComposerChange,
}: Props) {
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [composingExpId, setComposingExpId] = useState<string | null>(null);
  const composerHandleRef = useRef<BulletComposerHandle | null>(null);

  function openComposer(expId: string) {
    setComposingExpId(expId);
    onComposerChange?.({ expId, handleRef: composerHandleRef });
  }
  function closeComposer() {
    composerHandleRef.current = null;
    setComposingExpId(null);
    onComposerChange?.(null);
  }

  function patchContact<K extends keyof StructuredResume['contact']>(
    key: K,
    value: StructuredResume['contact'][K],
  ) {
    onChange({ ...resume, contact: { ...resume.contact, [key]: value } });
  }

  function patchExperience(id: string, patch: Partial<StructuredExperience>) {
    onChange({
      ...resume,
      experiences: resume.experiences.map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    });
  }
  function patchEducation(id: string, patch: Partial<StructuredEducation>) {
    onChange({
      ...resume,
      education: resume.education.map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    });
  }

  async function handleGenerateSummary() {
    setSummaryBusy(true);
    try {
      const s = await aiGenerateSummary(resume);
      onChange({ ...resume, summary: s });
    } finally {
      setSummaryBusy(false);
    }
  }

  async function handleRewriteAllBullets(expId: string) {
    const exp = resume.experiences.find((e) => e.id === expId);
    if (!exp) return;
    const rewritten = await aiRewriteBullets(exp.bullets);
    patchExperience(expId, { bullets: rewritten });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Contact */}
      <BuilderSection
        id="section-contact"
        title="Contact Information"
        defaultOpen
      >
        <div className="flex flex-col gap-3">
          <FieldRow label="Full name" cols={2}>
            <input
              className={inputClass}
              value={resume.contact.fullName}
              onChange={(e) => patchContact('fullName', e.target.value)}
              placeholder="e.g. David Poole"
            />
          </FieldRow>
          <FieldRow label="Email" cols={2}>
            <input
              type="email"
              className={inputClass}
              value={resume.contact.email}
              onChange={(e) => patchContact('email', e.target.value)}
              placeholder="you@example.com"
            />
          </FieldRow>
          <FieldRow label="Phone" cols={2}>
            <input
              className={inputClass}
              value={resume.contact.phone}
              onChange={(e) => patchContact('phone', e.target.value)}
              placeholder="(555) 123-4567"
            />
          </FieldRow>
          <FieldRow label="Location" cols={2}>
            <input
              className={inputClass}
              value={resume.contact.location}
              onChange={(e) => patchContact('location', e.target.value)}
              placeholder="San Francisco, CA"
            />
          </FieldRow>
          <FieldRow label="Links" cols={2}>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              {resume.contact.links.map((link, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full border border-ink-line bg-bg-muted/60 px-3 py-1 text-xs text-ink-700"
                >
                  {link}
                  <button
                    type="button"
                    onClick={() =>
                      patchContact(
                        'links',
                        resume.contact.links.filter((_, j) => j !== i),
                      )
                    }
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-ink-line-soft"
                    aria-label="Remove link"
                  >
                    <XMarkIcon className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              <input
                className={cn(inputClass, 'flex-1 min-w-[160px]')}
                placeholder="linkedin.com/in/you (press Enter to add)"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const v = (e.currentTarget.value || '').trim();
                  if (!v) return;
                  patchContact('links', [...resume.contact.links, v]);
                  e.currentTarget.value = '';
                }}
              />
            </div>
          </FieldRow>
        </div>
      </BuilderSection>

      {/* Target title */}
      <BuilderSection id="section-target" title="Target Title" defaultOpen>
        <FieldRow label="Target title">
          <input
            className={inputClass}
            value={resume.targetTitle}
            onChange={(e) =>
              onChange({ ...resume, targetTitle: e.target.value })
            }
            placeholder="e.g. AI Software Engineer"
          />
        </FieldRow>
      </BuilderSection>

      {/* Summary */}
      <BuilderSection
        id="section-summary"
        title="Professional Summary"
        defaultOpen
        actions={
          <button
            type="button"
            onClick={handleGenerateSummary}
            disabled={summaryBusy}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md border border-accent-text bg-accent-50 px-2 text-[11px] font-semibold text-accent-text transition-colors hover:bg-accent-100',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
            title="AI generate summary from your experience"
          >
            {summaryBusy ? (
              <ArrowPathIcon className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <SparklesIcon className="h-3 w-3" aria-hidden="true" />
            )}
            <span>{summaryBusy ? 'Drafting…' : 'AI Generate'}</span>
          </button>
        }
      >
        <textarea
          rows={5}
          value={resume.summary}
          onChange={(e) => onChange({ ...resume, summary: e.target.value })}
          placeholder="2-3 sentences. Lead with what you do, where, and the outcome you drive."
          className={cn(inputClass, 'resize-y')}
        />
      </BuilderSection>

      {/* Work experience */}
      <BuilderSection
        id="section-experience"
        title="Work Experience"
        subtitle={`${resume.experiences.length} ${resume.experiences.length === 1 ? 'entry' : 'entries'}`}
        defaultOpen
        actions={
          <button
            type="button"
            onClick={() =>
              onChange({
                ...resume,
                experiences: [...resume.experiences, blankExperience()],
              })
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-line bg-white px-2 text-[11px] font-semibold text-ink-700 transition-colors hover:bg-bg-muted"
            title="Add another experience"
          >
            <PlusIcon className="h-3 w-3" aria-hidden="true" />
            Add
          </button>
        }
      >
        <div className="flex flex-col gap-4">
          {resume.experiences.length === 0 ? (
            <p className="text-sm text-ink-500">
              No experience yet. Click <span className="font-semibold">+ Add</span> to write your first entry.
            </p>
          ) : null}
          {resume.experiences.map((exp) => (
            <div
              key={exp.id}
              id={`exp-${exp.id}`}
              className="rounded-md border border-ink-line-soft bg-bg-muted/30 p-3"
            >
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <input
                    className={inputClass}
                    value={exp.company}
                    onChange={(e) =>
                      patchExperience(exp.id, { company: e.target.value })
                    }
                    placeholder="Company"
                  />
                  <input
                    className={inputClass}
                    value={exp.title}
                    onChange={(e) =>
                      patchExperience(exp.id, { title: e.target.value })
                    }
                    placeholder="Role title"
                  />
                  <input
                    className={inputClass}
                    value={exp.startDate}
                    onChange={(e) =>
                      patchExperience(exp.id, { startDate: e.target.value })
                    }
                    placeholder="Start (e.g. 04/2022)"
                  />
                  <input
                    className={inputClass}
                    value={exp.endDate}
                    onChange={(e) =>
                      patchExperience(exp.id, { endDate: e.target.value })
                    }
                    placeholder="End (or 'Present')"
                  />
                  <input
                    className={cn(inputClass, 'sm:col-span-2')}
                    value={exp.location}
                    onChange={(e) =>
                      patchExperience(exp.id, { location: e.target.value })
                    }
                    placeholder="Location (optional)"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                      Bullets
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleRewriteAllBullets(exp.id)}
                        disabled={exp.bullets.length === 0}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-accent-text bg-accent-50 px-2 text-[11px] font-semibold text-accent-text transition-colors hover:bg-accent-100 disabled:cursor-not-allowed disabled:opacity-60"
                        title="AI rewrite every bullet under this role"
                      >
                        <SparklesIcon className="h-3 w-3" aria-hidden="true" />
                        Rewrite all
                      </button>
                      <button
                        type="button"
                        onClick={() => openComposer(exp.id)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-line bg-white px-2 text-[11px] font-semibold text-ink-700 transition-colors hover:bg-bg-muted"
                      >
                        <PlusIcon className="h-3 w-3" aria-hidden="true" />
                        Bullet
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    {exp.bullets.map((b, i) => (
                      <BuilderBulletEditor
                        key={`${exp.id}-${i}`}
                        value={b}
                        onChange={(next) => {
                          const bullets = [...exp.bullets];
                          bullets[i] = next;
                          patchExperience(exp.id, { bullets });
                        }}
                        onRemove={() =>
                          patchExperience(exp.id, {
                            bullets: exp.bullets.filter((_, j) => j !== i),
                          })
                        }
                      />
                    ))}
                    {composingExpId === exp.id ? (
                      <BuilderAddBullet
                        ref={(h) => {
                          composerHandleRef.current = h;
                        }}
                        context={{
                          company: exp.company,
                          title: exp.title,
                          existing: exp.bullets,
                        }}
                        onSave={(text) => {
                          patchExperience(exp.id, {
                            bullets: [...exp.bullets, text],
                          });
                          closeComposer();
                        }}
                        onCancel={closeComposer}
                      />
                    ) : null}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      onChange({
                        ...resume,
                        experiences: resume.experiences.filter(
                          (e) => e.id !== exp.id,
                        ),
                      })
                    }
                    className="text-xs font-medium text-danger transition-colors hover:underline"
                  >
                    Remove this experience
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </BuilderSection>

      {/* Education */}
      <BuilderSection
        id="section-education"
        title="Education"
        subtitle={`${resume.education.length} ${resume.education.length === 1 ? 'entry' : 'entries'}`}
        actions={
          <button
            type="button"
            onClick={() =>
              onChange({
                ...resume,
                education: [...resume.education, blankEducation()],
              })
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-line bg-white px-2 text-[11px] font-semibold text-ink-700 transition-colors hover:bg-bg-muted"
          >
            <PlusIcon className="h-3 w-3" aria-hidden="true" />
            Add
          </button>
        }
      >
        <div className="flex flex-col gap-4">
          {resume.education.length === 0 ? (
            <p className="text-sm text-ink-500">
              No education entries. Add at least one — most ATS filters require it.
            </p>
          ) : null}
          {resume.education.map((ed) => (
            <div
              key={ed.id}
              className="rounded-md border border-ink-line-soft bg-bg-muted/30 p-3"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  className={inputClass}
                  value={ed.school}
                  onChange={(e) =>
                    patchEducation(ed.id, { school: e.target.value })
                  }
                  placeholder="School"
                />
                <input
                  className={inputClass}
                  value={ed.degree}
                  onChange={(e) =>
                    patchEducation(ed.id, { degree: e.target.value })
                  }
                  placeholder="Degree"
                />
                <input
                  className={inputClass}
                  value={ed.startDate}
                  onChange={(e) =>
                    patchEducation(ed.id, { startDate: e.target.value })
                  }
                  placeholder="Start (e.g. 08/2015)"
                />
                <input
                  className={inputClass}
                  value={ed.endDate}
                  onChange={(e) =>
                    patchEducation(ed.id, { endDate: e.target.value })
                  }
                  placeholder="End (e.g. 05/2019)"
                />
                <input
                  className={cn(inputClass, 'sm:col-span-2')}
                  value={ed.location}
                  onChange={(e) =>
                    patchEducation(ed.id, { location: e.target.value })
                  }
                  placeholder="Location (optional)"
                />
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...resume,
                      education: resume.education.filter((e) => e.id !== ed.id),
                    })
                  }
                  className="text-xs font-medium text-danger transition-colors hover:underline"
                >
                  Remove this entry
                </button>
              </div>
            </div>
          ))}
        </div>
      </BuilderSection>

      {/* Skills */}
      <BuilderSection
        id="section-skills"
        title="Skills"
        subtitle={`${resume.skills.length} keyword${resume.skills.length === 1 ? '' : 's'}`}
        defaultOpen
      >
        <div className="flex flex-wrap items-center gap-2">
          {resume.skills.map((sk, i) => (
            <span
              key={`${sk}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border border-ink-line bg-bg-muted/60 px-3 py-1 text-xs text-ink-700"
            >
              {sk}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...resume,
                    skills: resume.skills.filter((_, j) => j !== i),
                  })
                }
                className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-ink-line-soft"
                aria-label={`Remove ${sk}`}
              >
                <XMarkIcon className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            className={cn(inputClass, 'min-w-[160px] flex-1')}
            placeholder="Type a skill and press Enter"
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ',') return;
              e.preventDefault();
              const v = (e.currentTarget.value || '').trim();
              if (!v) return;
              onChange({ ...resume, skills: [...resume.skills, v] });
              e.currentTarget.value = '';
            }}
          />
        </div>
      </BuilderSection>
    </div>
  );
}
