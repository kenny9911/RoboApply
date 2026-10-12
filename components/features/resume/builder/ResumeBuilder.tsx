'use client';

// components/features/resume/builder/ResumeBuilder.tsx — the guided resume
// builder at /resume/new (WP-65; PRODUCT_PLAN.md F-RES-17, F-RES-12 cn, TW-04).
//
// Steps come from the server (GET /builder/config) per brand and locale:
//   RoboApply   role → contact → education → experience (bullet prompts) → …
//   zh-TW       + 實習, 專案, 證照, 自傳, 期望待遇 (依公司規定 / 面議), photo
//   GoApply     基本信息, 求职意向, 教育, 实习, 项目 (STAR), 校园经历,
//               技能证书 (CET-4/6), 获奖, 自我评价, optional photo / 籍贯 / 政治面貌
// then Review → "Create resume" → the editor.
//
// AI writing help appears only when the server says AI may run for this user
// (consent + model); without it the builder works the same and nothing is sent
// to a model. Suggestions are labelled (AiGeneratedBadge on GoApply) and the
// user adds each one. Personal details and the photo never go to a model: the
// photo stays on this device, 籍贯 / 政治面貌 are printed by the file renderer.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Btn } from '../../../v3/primitives/Btn';
import { PageHeader } from '../../../v3/primitives/PageHeader';
import { apiErrorDetails, apiErrorReason } from '../../../../lib/api/contracts/wire';
import type { BuilderConfig, BuilderDocLanguage, BuilderSection } from '../../../../lib/api/resumes';
import { useBuilderConfig, useBuilderSuggest, useCreateFromBuilder } from '../../../../hooks/resume/useResumeBuilder';
import { draftPhotoId, purgeDraftPhotos, settleDraftPhoto, useResumePhoto } from '../../../../hooks/resume/useResumePhoto';
import { useAuth } from '../../../../lib/auth/AuthProvider';
import {
  blankDraft,
  blankEducation,
  blankEntry,
  blankProject,
  clearLocalDraft,
  contextLinesOf,
  entryNotes,
  loadLocalDraft,
  purgeLocalDrafts,
  saveLocalDraft,
  stepFilled,
  stepProblem,
  toRequest,
  type DraftState,
  type EntryDraft,
  type EntryListKey,
  type ProjectDraft,
} from './draft';
import { BulletList, SuggestPanel, TagList, TextArea, TextField } from './fields';
import styles from './Builder.module.css';

type StepKey = BuilderSection | 'review';

/** Common 政治面貌 values offered as suggestions (the user may type any). */
const POLITICAL_STATUS_OPTIONS = ['中共党员', '中共预备党员', '共青团员', '群众'];

export function ResumeBuilder() {
  const t = useTranslations('resumeBuilder');
  const router = useRouter();
  const config = useBuilderConfig();
  const auth = useAuth();
  const userId = auth.user?.id ?? null;
  // Signed out (logout or an expired session) while the builder is open:
  // remove what this browser kept for the builder.
  useEffect(() => {
    if (auth.status !== 'unauthenticated') return;
    purgeLocalDrafts(null);
    purgeDraftPhotos(null);
  }, [auth.status]);
  if (config.isError) {
    return (
      <div className={styles.card} role="alert">
        <p className={styles.body}>{t('loadError')}</p>
        <div className={styles.row}>
          <Btn onClick={() => void config.refetch()}>{t('retry')}</Btn>
        </div>
      </div>
    );
  }
  if (!config.data || auth.status === 'loading') {
    return (
      <p className={styles.body} role="status">
        {t('loading')}
      </p>
    );
  }
  return (
    <ResumeBuilderView
      key={userId ?? 'signed-out'}
      config={config.data}
      userId={userId}
      onCreated={(id) => router.push(`/resume/${encodeURIComponent(id)}`)}
    />
  );
}

export function ResumeBuilderView({
  config,
  onCreated,
  userId = null,
}: {
  config: BuilderConfig;
  onCreated: (resumeId: string) => void;
  /** The signed-in user: the unsent draft and draft photo are kept per user (null = this visit only). */
  userId?: string | null;
}) {
  const t = useTranslations('resumeBuilder');
  const steps: StepKey[] = useMemo(() => [...config.steps.map((s) => s.key), 'review'], [config.steps]);
  const aiFor = useMemo(() => new Map(config.steps.map((s) => [s.key, s.ai])), [config.steps]);
  const optional = useMemo(() => new Map(config.steps.map((s) => [s.key, s.optional])), [config.steps]);
  const [draft, setDraft] = useState<DraftState>(() => blankDraft(config.defaultDocLanguage, config.photo.defaultOn[config.defaultDocLanguage]));
  const [index, setIndex] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const restored = useRef(false);
  const photo = useResumePhoto(userId ? draftPhotoId(userId) : null);
  const create = useCreateFromBuilder();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Restore this user's unsent draft from this browser (personal details are
  // never kept); drafts and draft photos left by anyone else are removed.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    purgeLocalDrafts(userId);
    purgeDraftPhotos(userId);
    const saved = loadLocalDraft(userId);
    if (saved && saved.basics && config.docLanguages.includes(saved.docLanguage as BuilderDocLanguage)) {
      setDraft((d) => ({ ...d, ...saved, personal: d.personal }));
    }
  }, [config.docLanguages, userId]);
  useEffect(() => {
    if (restored.current) saveLocalDraft(userId, draft);
  }, [draft, userId]);

  const step = steps[index]!;
  const update = (patch: Partial<DraftState>) => setDraft((d) => ({ ...d, ...patch }));
  const go = (to: number) => {
    setProblem(null);
    setIndex(Math.max(0, Math.min(steps.length - 1, to)));
    window.requestAnimationFrame?.(() => headingRef.current?.focus());
  };
  const next = () => {
    if (step !== 'review') {
      const p = stepProblem(step, draft);
      if (p) {
        setProblem(p);
        return;
      }
    }
    go(index + 1);
  };
  const submit = async () => {
    for (const s of config.steps) {
      const p = stepProblem(s.key, draft);
      if (p) {
        setProblem(p);
        go(steps.indexOf(s.key));
        setProblem(p);
        return;
      }
    }
    try {
      const body = toRequest(draft, { personal: config.personalFields.length > 0, photoOffered: config.photo.offered });
      const res = await create.mutateAsync(body);
      // The draft photo is always removed; it moves to the resume only when kept.
      settleDraftPhoto({ userId, resumeId: res.resumeId, photo: photo.photo, adopt: Boolean(body.photo) });
      clearLocalDraft(userId);
      onCreated(res.resumeId);
    } catch {
      // shown below
    }
  };

  const title = step === 'review' ? t('step.review.title') : t(`step.${step}.title`);
  const hint = step === 'review' ? t('step.review.hint') : t(`step.${step}.hint`);
  const createError = create.error
    ? apiErrorReason(create.error) === 'resume_limit_reached'
      ? t('errors.limit', { limit: Number(apiErrorDetails<{ limit?: number }>(create.error)?.limit ?? 5) })
      : t('errors.generic')
    : null;

  return (
    <>
      <PageHeader eyebrow={t('header.eyebrow')} title={t('header.title')} sub={t('header.sub')} />
      <div className={styles.page}>
        <nav aria-label={t('stepsLabel')}>
          <ol className={styles.steps}>
            {steps.map((s, i) => (
              <li key={s}>
                <button type="button" className={styles.stepBtn} aria-current={i === index ? 'step' : undefined} onClick={() => go(i)}>
                  <span className={`${styles.stepDot} ${s !== 'review' && stepFilled(s, draft) ? styles.stepDotDone : ''}`} aria-hidden="true" />
                  {s === 'review' ? t('step.review.title') : t(`step.${s}.title`)}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <section className={styles.card} aria-labelledby="builder-step-title">
          <div className={styles.mobileProgress}>
            <span className={styles.fieldHint}>{t('progress', { current: index + 1, total: steps.length })}</span>
            <div className={styles.bar} aria-hidden="true">
              <div className={styles.barFill} style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
            </div>
          </div>
          <h2 id="builder-step-title" ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
            {title}
          </h2>
          <p className={styles.hint}>{hint}</p>
          {!config.aiAvailable && aiFor.has(step as BuilderSection) && BUILDER_AI_STEPS.has(step) ? <p className={styles.notice}>{t('ai.off')}</p> : null}

          <StepBody step={step} draft={draft} update={update} config={config} aiKind={step === 'review' ? null : aiFor.get(step) ?? null} photo={photo} goTo={(s) => go(steps.indexOf(s))} />

          {problem ? (
            <p className={styles.error} role="alert">
              {t(`errors.${problem}`)}
            </p>
          ) : null}
          {createError ? (
            <p className={styles.error} role="alert">
              {createError}{' '}
              {apiErrorReason(create.error) === 'resume_limit_reached' ? (
                <a href="/resume" className={styles.btnText}>
                  {t('links.backToResumes')}
                </a>
              ) : null}
            </p>
          ) : null}

          <div className={styles.nav}>
            {index > 0 ? (
              <Btn type="button" variant="ghost" onClick={() => go(index - 1)}>
                {t('nav.back')}
              </Btn>
            ) : (
              <Btn as="a" href="/resume" variant="ghost">
                {t('links.backToResumes')}
              </Btn>
            )}
            <div className={styles.navEnd}>
              {step !== 'review' && optional.get(step) ? (
                <Btn type="button" variant="ghost" onClick={() => go(index + 1)}>
                  {t('nav.skip')}
                </Btn>
              ) : null}
              {step === 'review' ? (
                <Btn type="button" variant="primary" onClick={() => void submit()} disabled={create.isPending} aria-busy={create.isPending || undefined}>
                  {create.isPending ? t('nav.creating') : t('nav.create')}
                </Btn>
              ) : (
                <Btn type="button" variant="primary" onClick={next}>
                  {index === steps.length - 2 ? t('nav.review') : t('nav.next')}
                </Btn>
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** Steps that have writing help (the "help is off" note shows there). */
const BUILDER_AI_STEPS = new Set<StepKey>(['experience', 'internship', 'projects', 'campus', 'summary', 'selfEvaluation']);

function DocLanguagePicker({ config, value, onChange }: { config: BuilderConfig; value: BuilderDocLanguage; onChange: (v: BuilderDocLanguage) => void }) {
  const t = useTranslations('resumeBuilder');
  if (config.docLanguages.length < 2) return null;
  return (
    <fieldset className={`${styles.field} ${styles.full}`}>
      <legend className={styles.label}>{t('docLanguage.label')}</legend>
      <div className={styles.chips}>
        {config.docLanguages.map((lang) => (
          <button key={lang} type="button" className={styles.chip} aria-pressed={value === lang} onClick={() => onChange(lang)}>
            {t(`docLanguage.${lang === 'zh-TW' ? 'zhTW' : lang}`)}
          </button>
        ))}
      </div>
      <span className={styles.fieldHint}>{t('docLanguage.hint')}</span>
    </fieldset>
  );
}

interface StepProps {
  step: StepKey;
  draft: DraftState;
  update: (patch: Partial<DraftState>) => void;
  config: BuilderConfig;
  aiKind: 'bullets' | 'summary' | 'self_evaluation' | null;
  photo: ReturnType<typeof useResumePhoto>;
  goTo: (step: StepKey) => void;
}

function StepBody(props: StepProps) {
  const { step, draft, update, config } = props;
  const t = useTranslations('resumeBuilder');
  switch (step) {
    case 'basics':
      return (
        <div className={styles.grid}>
          <DocLanguagePicker
            config={config}
            value={draft.docLanguage}
            onChange={(docLanguage) => update({ docLanguage, photo: config.photo.offered && config.photo.defaultOn[docLanguage] })}
          />
          <TextField label={t('field.fullName')} value={draft.basics.fullName} required maxLength={80} onChange={(v) => update({ basics: { ...draft.basics, fullName: v } })} />
          <TextField label={t('field.email')} type="email" value={draft.basics.email} onChange={(v) => update({ basics: { ...draft.basics, email: v } })} />
          <TextField label={t('field.phone')} type="tel" value={draft.basics.phone} maxLength={40} onChange={(v) => update({ basics: { ...draft.basics, phone: v } })} />
          <TextField label={t('field.city')} value={draft.basics.city} onChange={(v) => update({ basics: { ...draft.basics, city: v } })} />
          <TextField
            label={t('field.links')}
            hint={t('field.linksHint')}
            full
            maxLength={400}
            value={draft.basics.links.join(', ')}
            onChange={(v) => update({ basics: { ...draft.basics, links: v.split(/[,\s]+/).filter(Boolean).slice(0, 4) } })}
          />
        </div>
      );
    case 'intent':
      return (
        <div className={styles.grid}>
          <TextField label={t('field.targetTitle')} value={draft.intent.targetTitle} required full onChange={(v) => update({ intent: { ...draft.intent, targetTitle: v } })} />
          {config.variant !== 'intl' ? (
            <>
              <TextField label={t('field.cities')} value={draft.intent.cities} onChange={(v) => update({ intent: { ...draft.intent, cities: v } })} />
              <TextField label={t('field.availableFrom')} value={draft.intent.availableFrom} maxLength={60} onChange={(v) => update({ intent: { ...draft.intent, availableFrom: v } })} />
            </>
          ) : null}
          {config.salaryKinds.length ? (
            <fieldset className={`${styles.field} ${styles.full}`}>
              <legend className={styles.label}>{t('field.salary')}</legend>
              <div className={styles.chips}>
                {(['none', ...config.salaryKinds] as const).map((k) => (
                  <button key={k} type="button" className={styles.chip} aria-pressed={draft.intent.salaryKind === k} onClick={() => update({ intent: { ...draft.intent, salaryKind: k } })}>
                    {t(`field.salaryKind.${k}`)}
                  </button>
                ))}
              </div>
              {draft.intent.salaryKind === 'amount' ? (
                <TextField label={t('field.salaryAmount')} hint={t('field.salaryAmountHint')} value={draft.intent.salaryAmount} maxLength={60} onChange={(v) => update({ intent: { ...draft.intent, salaryAmount: v } })} />
              ) : null}
            </fieldset>
          ) : null}
        </div>
      );
    case 'education':
      return (
        <>
          {draft.education.map((e, i) => (
            <div key={e.key} className={styles.entry}>
              <EntryHead
                label={t('entry.label', { n: i + 1 })}
                onRemove={draft.education.length > 1 ? () => update({ education: draft.education.filter((x) => x.key !== e.key) }) : undefined}
              />
              <div className={styles.grid}>
                <TextField label={t('field.school')} value={e.school} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, school: v } : x)) })} />
                <TextField label={t('field.degree')} value={e.degree} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, degree: v } : x)) })} />
                <TextField label={t('field.major')} value={e.major} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, major: v } : x)) })} />
                <TextField label={t('field.gpa')} value={e.gpa} maxLength={30} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, gpa: v } : x)) })} />
                <TextField label={t('field.start')} value={e.start} maxLength={30} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, start: v } : x)) })} />
                <TextField label={t('field.end')} value={e.end} maxLength={30} onChange={(v) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, end: v } : x)) })} />
                <BulletList label={t('field.details')} hint={t('field.detailsHint')} items={e.details} onChange={(details) => update({ education: draft.education.map((x) => (x.key === e.key ? { ...x, details } : x)) })} />
              </div>
            </div>
          ))}
          <div className={styles.row}>
            <button type="button" className={styles.btnText} onClick={() => update({ education: [...draft.education, blankEducation()] })}>
              {t('entry.add.education')}
            </button>
          </div>
        </>
      );
    case 'experience':
    case 'internship':
    case 'campus':
      return <EntryStep {...props} list={step} />;
    case 'projects':
      return <ProjectStep {...props} />;
    case 'skills':
      return (
        <div className={styles.grid}>
          <TagList label={t('field.skills')} addLabel={t('field.add')} items={draft.skills} maxLength={60} onChange={(skills) => update({ skills })} />
        </div>
      );
    case 'certificates':
      return (
        <div className={styles.grid}>
          <TagList label={t('field.certificates')} addLabel={t('field.add')} items={draft.certificates} suggestions={config.certificateSuggestions} onChange={(certificates) => update({ certificates })} />
          {config.certificateSuggestions.length ? <p className={`${styles.fieldHint} ${styles.full}`}>{t('field.certificatesHint')}</p> : null}
          {config.variant === 'cn' ? <TagList label={t('field.skills')} addLabel={t('field.add')} items={draft.skills} maxLength={60} onChange={(skills) => update({ skills })} /> : null}
        </div>
      );
    case 'awards':
      return (
        <div className={styles.grid}>
          <BulletList label={t('field.awards')} hint={t('field.awardsHint')} items={draft.awards} onChange={(awards) => update({ awards })} />
        </div>
      );
    case 'summary':
    case 'selfEvaluation':
      return <TextStep {...props} field={step} />;
    case 'autobiography':
      return (
        <div className={styles.grid}>
          <TextArea label={t('field.autobiography')} hint={t('field.autobiographyHint')} rows={10} maxLength={4000} value={draft.autobiography} onChange={(autobiography) => update({ autobiography })} />
        </div>
      );
    case 'personal':
      return <PersonalStep {...props} />;
    case 'review':
      return <ReviewStep {...props} />;
    default:
      return null;
  }
}

function EntryHead({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const t = useTranslations('resumeBuilder');
  return (
    <div className={styles.entryHead}>
      <p className={styles.entryLabel}>{label}</p>
      {onRemove ? (
        <button type="button" className={styles.btnText} onClick={onRemove}>
          {t('entry.remove')}
        </button>
      ) : null}
    </div>
  );
}

/** AI suggestion state for one target (an entry, a project, the summary). */
function useSuggestions() {
  const suggest = useBuilderSuggest();
  const [items, setItems] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(0);
  const run = async (body: Parameters<typeof suggest.mutateAsync>[0]) => {
    setItems([]);
    try {
      const res = await suggest.mutateAsync(body);
      setItems(res.suggestions.map((s) => s.text));
      setBlocked(res.blocked);
    } catch {
      setBlocked(0);
    }
  };
  return { run, items, setItems, blocked, busy: suggest.isPending, error: suggest.error };
}

function EntryStep({ draft, update, config, aiKind, list }: StepProps & { list: EntryListKey }) {
  const t = useTranslations('resumeBuilder');
  const rows = draft[list];
  const set = (key: string, patch: Partial<EntryDraft>) => update({ [list]: rows.map((x) => (x.key === key ? { ...x, ...patch } : x)) } as Partial<DraftState>);
  return (
    <>
      <p className={styles.notice}>{t('prompts.bullets')}</p>
      {rows.map((e, i) => (
        <EntryCard
          key={e.key}
          entry={e}
          index={i}
          list={list}
          draft={draft}
          config={config}
          aiKind={aiKind}
          onChange={(patch) => set(e.key, patch)}
          onAiText={(text) => update({ aiTexts: [...draft.aiTexts, text] })}
          onRemove={rows.length > 1 ? () => update({ [list]: rows.filter((x) => x.key !== e.key) } as Partial<DraftState>) : undefined}
        />
      ))}
      <div className={styles.row}>
        <button type="button" className={styles.btnText} onClick={() => update({ [list]: [...rows, blankEntry()] } as Partial<DraftState>)}>
          {t(`entry.add.${list}`)}
        </button>
      </div>
    </>
  );
}

function EntryCard({
  entry: e,
  index,
  list,
  draft,
  config,
  aiKind,
  onChange,
  onAiText,
  onRemove,
}: {
  entry: EntryDraft;
  index: number;
  list: EntryListKey;
  draft: DraftState;
  config: BuilderConfig;
  aiKind: StepProps['aiKind'];
  onChange: (patch: Partial<EntryDraft>) => void;
  onAiText: (text: string) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('resumeBuilder');
  const s = useSuggestions();
  const notes = entryNotes(e);
  return (
    <div className={styles.entry}>
      <EntryHead label={t('entry.label', { n: index + 1 })} onRemove={onRemove} />
      <div className={styles.grid}>
        <TextField label={t(list === 'campus' ? 'field.campusTitle' : 'field.title')} value={e.title} onChange={(v) => onChange({ title: v })} />
        <TextField label={t(list === 'campus' ? 'field.campusOrganization' : 'field.organization')} value={e.organization} onChange={(v) => onChange({ organization: v })} />
        <TextField label={t('field.start')} value={e.start} maxLength={30} onChange={(v) => onChange({ start: v })} />
        <TextField label={t('field.end')} hint={t('field.endHint')} value={e.end} maxLength={30} onChange={(v) => onChange({ end: v })} />
        {config.variant === 'intl' ? <TextField label={t('field.location')} value={e.location} full onChange={(v) => onChange({ location: v })} /> : null}
        {aiKind === 'bullets' ? (
          <TextArea label={t('field.notes')} hint={t('field.notesHint')} rows={3} maxLength={2000} value={e.notes} onChange={(v) => onChange({ notes: v })} />
        ) : null}
        <BulletList label={t('field.bullets')} items={e.bullets} onChange={(bullets) => onChange({ bullets })} />
      </div>
      <SuggestPanel
        enabled={aiKind === 'bullets'}
        label={t('ai.suggestBullets')}
        busy={s.busy}
        error={s.error}
        suggestions={s.items}
        blocked={s.blocked}
        canRun={notes.length > 0}
        onRun={() =>
          void s.run({
            kind: 'bullets',
            docLanguage: draft.docLanguage,
            targetTitle: draft.intent.targetTitle,
            entry: { title: e.title, organization: e.organization, section: list },
            notes,
          })
        }
        onUse={(text) => {
          const kept = e.bullets.filter((b) => b.trim());
          onChange({ bullets: [...kept, text] });
          onAiText(text);
          s.setItems(s.items.filter((x) => x !== text));
        }}
      />
    </div>
  );
}

function ProjectStep({ draft, update, aiKind }: StepProps) {
  const t = useTranslations('resumeBuilder');
  const set = (key: string, patch: Partial<ProjectDraft>) => update({ projects: draft.projects.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  return (
    <>
      <p className={styles.notice}>{t('prompts.star')}</p>
      {draft.projects.map((p, i) => (
        <ProjectCard
          key={p.key}
          project={p}
          index={i}
          draft={draft}
          aiKind={aiKind}
          onChange={(patch) => set(p.key, patch)}
          onAiText={(text) => update({ aiTexts: [...draft.aiTexts, text] })}
          onRemove={draft.projects.length > 1 ? () => update({ projects: draft.projects.filter((x) => x.key !== p.key) }) : undefined}
        />
      ))}
      <div className={styles.row}>
        <button type="button" className={styles.btnText} onClick={() => update({ projects: [...draft.projects, blankProject()] })}>
          {t('entry.add.projects')}
        </button>
      </div>
    </>
  );
}

function ProjectCard({
  project: p,
  index,
  draft,
  aiKind,
  onChange,
  onAiText,
  onRemove,
}: {
  project: ProjectDraft;
  index: number;
  draft: DraftState;
  aiKind: StepProps['aiKind'];
  onChange: (patch: Partial<ProjectDraft>) => void;
  onAiText: (text: string) => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('resumeBuilder');
  const s = useSuggestions();
  const notes = entryNotes(p);
  const setStar = (k: keyof ProjectDraft['star'], v: string) => onChange({ star: { ...p.star, [k]: v } });
  return (
    <div className={styles.entry}>
      <EntryHead label={t('entry.label', { n: index + 1 })} onRemove={onRemove} />
      <div className={styles.grid}>
        <TextField label={t('field.projectName')} value={p.name} onChange={(v) => onChange({ name: v })} />
        <TextField label={t('field.role')} value={p.role} onChange={(v) => onChange({ role: v })} />
        <TextField label={t('field.start')} value={p.start} maxLength={30} onChange={(v) => onChange({ start: v })} />
        <TextField label={t('field.end')} value={p.end} maxLength={30} onChange={(v) => onChange({ end: v })} />
        <TextField label={t('field.link')} type="url" value={p.link} full maxLength={200} onChange={(v) => onChange({ link: v })} />
        {(['situation', 'task', 'action', 'result'] as const).map((k) => (
          <TextArea key={k} label={t(`field.star.${k}`)} hint={t(`field.star.${k}Hint`)} rows={2} maxLength={400} value={p.star[k]} onChange={(v) => setStar(k, v)} />
        ))}
        <BulletList label={t('field.moreBullets')} items={p.bullets} onChange={(bullets) => onChange({ bullets })} />
      </div>
      <SuggestPanel
        enabled={aiKind === 'bullets'}
        label={t('ai.suggestBullets')}
        busy={s.busy}
        error={s.error}
        suggestions={s.items}
        blocked={s.blocked}
        canRun={notes.length > 0}
        onRun={() =>
          void s.run({
            kind: 'bullets',
            docLanguage: draft.docLanguage,
            targetTitle: draft.intent.targetTitle,
            entry: { title: p.role, organization: p.name, section: 'projects' },
            notes,
          })
        }
        onUse={(text) => {
          onChange({ bullets: [...p.bullets.filter((b) => b.trim()), text] });
          onAiText(text);
          s.setItems(s.items.filter((x) => x !== text));
        }}
      />
    </div>
  );
}

function TextStep({ draft, update, aiKind, field }: StepProps & { field: 'summary' | 'selfEvaluation' }) {
  const t = useTranslations('resumeBuilder');
  const s = useSuggestions();
  const context = contextLinesOf(draft);
  const value = draft[field];
  return (
    <div className={styles.grid}>
      <TextArea label={t(`field.${field}`)} hint={t(`field.${field}Hint`)} rows={5} maxLength={1500} value={value} onChange={(v) => update({ [field]: v } as Partial<DraftState>)} />
      <div className={styles.full}>
        <SuggestPanel
          enabled={aiKind === 'summary' || aiKind === 'self_evaluation'}
          label={t(field === 'summary' ? 'ai.suggestSummary' : 'ai.suggestSelfEvaluation')}
          busy={s.busy}
          error={s.error}
          suggestions={s.items}
          blocked={s.blocked}
          canRun={context.length > 0}
          useLabel={t('ai.use')}
          onRun={() => void s.run({ kind: field === 'summary' ? 'summary' : 'self_evaluation', docLanguage: draft.docLanguage, targetTitle: draft.intent.targetTitle, context })}
          onUse={(text) => {
            update({ [field]: text, aiTexts: [...draft.aiTexts, text] } as Partial<DraftState>);
            s.setItems([]);
          }}
        />
      </div>
    </div>
  );
}

function PersonalStep({ draft, update, config, photo }: StepProps) {
  const t = useTranslations('resumeBuilder');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileId = 'builder-photo-file';
  return (
    <div className={styles.grid}>
      <p className={`${styles.notice} ${styles.full}`}>{t('personal.intro')}</p>
      {config.personalFields.includes('nativePlace') ? (
        <TextField label={t('field.nativePlace')} value={draft.personal.nativePlace} maxLength={40} onChange={(v) => update({ personal: { ...draft.personal, nativePlace: v } })} />
      ) : null}
      {config.personalFields.includes('politicalStatus') ? (
        <>
          <TextField
            label={t('field.politicalStatus')}
            value={draft.personal.politicalStatus}
            maxLength={20}
            list="builder-political-status"
            onChange={(v) => update({ personal: { ...draft.personal, politicalStatus: v } })}
          />
          <datalist id="builder-political-status">
            {POLITICAL_STATUS_OPTIONS.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      ) : null}
      {config.photo.offered ? (
        <div className={styles.full}>
          <label className={styles.check}>
            <input type="checkbox" checked={draft.photo} onChange={(e) => update({ photo: e.target.checked })} />
            <span>{t('photo.label')}</span>
          </label>
          <p className={styles.fieldHint}>{t('photo.hint')}</p>
          {draft.photo ? (
            <div className={styles.photoRow}>
              {photo.photo ? (
                // A data: URL from this device; next/image adds nothing here.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.photo} alt={t('photo.alt')} className={styles.photo} />
              ) : null}
              <label htmlFor={fileId} className={styles.btnText}>
                {photo.photo ? t('photo.replace') : t('photo.choose')}
              </label>
              <input
                id={fileId}
                type="file"
                accept="image/jpeg,image/png"
                className={styles.visuallyHidden}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setPhotoError(null);
                  try {
                    await photo.save(file);
                  } catch (err) {
                    setPhotoError(err instanceof Error && err.message === 'unsupported_photo' ? t('photo.errors.unsupported') : t('photo.errors.tooLarge'));
                  }
                }}
              />
              {photo.photo ? (
                <button type="button" className={styles.btnText} onClick={photo.remove}>
                  {t('photo.remove')}
                </button>
              ) : null}
            </div>
          ) : null}
          {photoError ? (
            <p className={styles.error} role="alert">
              {photoError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReviewStep({ draft, config, goTo }: StepProps) {
  const t = useTranslations('resumeBuilder');
  return (
    <>
      <ul className={styles.reviewList}>
        {config.steps.map((s) => {
          const filled = stepFilled(s.key, draft);
          return (
            <li key={s.key} className={styles.reviewItem}>
              <span>
                {t(`step.${s.key}.title`)} <span className={styles.muted}>· {filled ? t('review.filled') : t('review.empty')}</span>
              </span>
              <button type="button" className={styles.btnText} onClick={() => goTo(s.key)} aria-label={t('review.editStep', { step: t(`step.${s.key}.title`) })}>
                {t('review.edit')}
              </button>
            </li>
          );
        })}
      </ul>
      <p className={styles.hint}>{t('review.after')}</p>
    </>
  );
}
