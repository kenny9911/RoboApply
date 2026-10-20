'use client';

// /resume — the resume hub (WP-36b; PRODUCT_PLAN.md F-RES-02), AI first. Tabs:
// Resumes · Cover letters (/resume/letters, WP-37). Up to 5 base resumes (Free
// and Pro) with one primary and a target title each; tailored versions are
// listed per job underneath and do not take a slot. LinkedIn means the user's
// own "Save to PDF" export only (no URL import; hidden on GoApply).
//
// Layout (components/features/resume/hub):
//   PageHeader · ResumeHubTabs
//   Studio     — TailorPanel: AI tailoring from a saved job (those without a
//                tailored version) or a pasted posting (only when AI may run
//                for this user, R-04) · beside it NextSteps ("Up next":
//                details to verify, the main resume's check) and AskAssistant
//                (questions about the main resume, when the Assistant is on)
//   Library    — LibraryCard per base resume (the resume itself as the
//                preview, its latest check, target title, actions) and the
//                NewResumeTile (upload or drop a file, guided builder at
//                /resume/new, template, LinkedIn PDF)
//   Tailored   — TailoredVersions, grouped per job
// First visit (no base resume): ResumeStart in place of studio and library.
//
// Data: `useResumeList()` for the library; per card `useResume(id)` (preview)
// and `useLatestResumeCheck(id)` (check). The main resume's latest check also
// says whether AI may run for this user (`aiAvailable`), which with the
// `ai.text` flag gates tailoring exactly as useTailorAvailability does. Saved
// jobs come from the tracker (useTailorTargets), read only when tailoring is
// available. Creating goes through ImportModal; "Open editor" pushes
// `/resume/[id]`, the only coupling point with the editor.
//
// The (auth) layout already wraps children in `.main-inner`, so this page does
// NOT render its own wrapper. All strings live under the `resume` namespace.

import { Suspense, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { parseResumeMarkdown } from '../../../lib/resumeStructure';
import { PageHeader, Btn, EmptyState } from '../../../components/v3/primitives';
import { ImportModal, joinPhrase, type ImportSource, type ImportCreateContext } from '../../../components/v3/resumes';
import {
  useResumeList,
  useCreateResumeMutation,
  useUploadResumeMutation,
  useImportLinkedInMutation,
  useDeleteResumeMutation,
  useSetPrimaryResumeMutation,
} from '../../../hooks/useResumes';
import { useLatestResumeCheck } from '../../../hooks/resume/useResumeCheck';
import { useBuilderConfig } from '../../../hooks/resume/useResumeBuilder';
import { useTailorTargets } from '../../../hooks/tailor';
import { useOpenAssistant } from '../../../hooks/shared/useOpenAssistant';
import { patchResume, BASE_RESUME_LIMIT, RESUME_UPLOADS_PER_DAY, type ResumeSummary } from '../../../lib/api/resumes';
import { RoboApiError } from '../../../lib/api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useBrand } from '../../../lib/brand';
import { useFlag } from '../../../lib/flags';
import { DeleteResumeConfirm } from '../../../components/resumes/DeleteResumeConfirm';
import {
  AskAssistant,
  BaseSlots,
  LibraryCard,
  NewResumeTile,
  NextSteps,
  ResumeHubTabs,
  ResumeStart,
  TailorPanel,
  TailoredVersions,
  checkStateOf,
  isBaseSlot,
  mainResumeOf,
  nextSteps,
  sortBases,
  untailoredJobs,
  type StartMethod,
} from '../../../components/features/resume';
import { TailorLaunchHost, TailorSheet } from '../../../components/features/tailor';
import styles from '../../../components/features/resume/hub/Hub.module.css';
import type { RAResumeVariant, ResumeCreateBody } from '../../../lib/api/v2/types';

// Stub-side seed markdown for an upload / LinkedIn import or a fresh scratch
// draft. The real upload-parse + LinkedIn pull is a Wave-later concern; for the
// stub the modal "parses" cosmetically and we persist this starter body so the
// editor (Lane F) has something to open.
const SCRATCH_MARKDOWN = `# Your Name

Senior Product Manager · you@email.com · City, Country

## Summary

A two-sentence pitch. The agent will help you sharpen this in the editor.

## Experience

**Company** — Title · 20XX–Present
- A first bullet. Click ✦ in the editor to rewrite it with metrics.

## Education

**School** — Degree · Year

## Skills

Product strategy · Roadmapping · Experimentation
`;

/** How a resume began, as the card names it (`sourceKind`; unknown kinds say nothing). */
const SOURCE_LABELS = ['upload', 'linkedin', 'template', 'scratch'] as const;

interface Tailoring {
  resumeId: string;
  jobId: string | null;
  jobTitle: string | null;
}

export default function ResumesPage() {
  const t = useTranslations('resume');
  const locale = useLocale();
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useResumeList();
  const createMut = useCreateResumeMutation();
  const uploadMut = useUploadResumeMutation();
  const importLinkedInMut = useImportLinkedInMutation();
  const deleteMut = useDeleteResumeMutation();
  const primaryMut = useSetPrimaryResumeMutation();
  const qc = useQueryClient();
  const brand = useBrand();
  // GoApply has no LinkedIn door (PRODUCT_PLAN.md G-onboarding resume step).
  const showLinkedIn = brand.market !== 'cn';

  const [importing, setImporting] = useState<{ source: ImportSource; file: File | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResumeSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tailoring, setTailoring] = useState<Tailoring | null>(null);
  const [baseChoice, setBaseChoice] = useState<string | null>(null);

  const resumes = useMemo(() => data?.resumes ?? [], [data]);
  // Base resumes (they take a slot), primary first, then newest edit.
  const bases = useMemo(() => sortBases(resumes), [resumes]);
  const tailored = useMemo(() => resumes.filter((r) => !isBaseSlot(r)), [resumes]);
  const baseNames = useMemo(() => new Map(resumes.map((r) => [r.id, r.name])), [resumes]);
  const tailoredPerBase = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of tailored) if (r.basedOnVariantId) counts.set(r.basedOnVariantId, (counts.get(r.basedOnVariantId) ?? 0) + 1);
    return counts;
  }, [tailored]);
  const slotsFull = bases.length >= BASE_RESUME_LIMIT;
  const main = mainResumeOf(bases);
  const baseId = (baseChoice && bases.some((b) => b.id === baseChoice) ? baseChoice : main?.id) ?? null;

  // AI tailoring: the brand capability AND this user's consent, which the
  // server answers on the main resume's latest check (useTailorAvailability).
  // Without both, no AI entry is shown (R-04).
  const aiText = useFlag('ai.text');
  const mainCheck = useLatestResumeCheck(main?.id);
  const tailorAvailable = aiText && mainCheck.data?.aiAvailable === true;
  const targets = useTailorTargets(tailorAvailable);
  const untailored = useMemo(() => untailoredJobs(targets.data ?? [], resumes), [targets.data, resumes]);
  const steps = nextSteps({ resumes, main: main ? { resume: main, check: checkStateOf(mainCheck) } : null });
  const stepsLoading = Boolean(main) && mainCheck.isLoading;
  const showStudio = tailorAvailable || stepsLoading || steps.length > 0;

  // The guided builder says itself whether its AI writing help is on.
  const builderAi = useBuilderConfig().data?.aiAvailable === true;

  // Questions for the Assistant, scoped to the main resume (F-RES-11).
  const assistantOn = useFlag('copilot');
  const openAssistant = useOpenAssistant();

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  function sourceLabel(r: ResumeSummary): string | null {
    const kind = SOURCE_LABELS.find((k) => k === r.sourceKind);
    return kind ? t(`hub.card.source.${kind}`) : null;
  }

  async function saveTargetTitle(id: string, title: string) {
    await patchResume(id, { targetTitle: title });
    await qc.invalidateQueries({ queryKey: ['v2', 'resumes'] });
  }

  function startTailoring(resumeId: string | null, jobId: string | null) {
    if (!resumeId) return;
    const job = jobId ? (targets.data ?? []).find((j) => j.jobId === jobId) : null;
    setTailoring({ resumeId, jobId, jobTitle: job?.title ?? null });
  }

  // Build the create body for the scratch source (template clone). `file` and
  // `linkedin` no longer flow through here — both upload + parse for real (see
  // handleCreate). The base fallback only guards a degenerate empty-file case.
  function buildCreateBody(ctx: ImportCreateContext): ResumeCreateBody {
    if (ctx.source === 'scratch') {
      return {
        kind: 'from_template',
        name: t('create.default_name.scratch'),
        templateKey: ctx.templateKey,
      };
    }
    return { kind: 'base', name: t('create.default_name.file'), resumeMarkdown: SCRATCH_MARKDOWN };
  }

  async function handleCreate(ctx: ImportCreateContext): Promise<RAResumeVariant> {
    // Real upload-parse for a picked file; everything else is a JSON create.
    if (ctx.source === 'file' && ctx.file) {
      return uploadMut.mutateAsync({ file: ctx.file });
    }
    // LinkedIn import — the user's own "Save to PDF" file. Parses for real.
    if (ctx.source === 'linkedin' && ctx.file) {
      return importLinkedInMut.mutateAsync({ mode: 'pdf', file: ctx.file });
    }
    return createMut.mutateAsync(buildCreateBody(ctx));
  }

  // What a new draft from a template is made of, shown while it is created.
  // (A file shows nothing of the kind: see importFacts.)
  function ingestRows(source: ImportSource) {
    if (source !== 'scratch') return [];
    return [
      { k: t('ingest.scratch.template'), v: t('ingest.scratch.template_v') },
      { k: t('ingest.scratch.sections'), v: t('ingest.scratch.sections_v') },
      { k: t('ingest.scratch.ai'), v: t('ingest.scratch.ai_v') },
      { k: t('ingest.scratch.ready'), v: t('ingest.scratch.ready_v') },
    ];
  }

  // What was actually read from an uploaded file: counted from the saved
  // resume, after the server answered. A section the file did not have says
  // so (D3: no fixed "Experience ✓ Roles · titles · dates" list, no made-up count).
  function importFacts(variant: RAResumeVariant) {
    const read = parseResumeMarkdown(variant.resumeMarkdown ?? '');
    const row = (k: string, count: number, v: string) => ({ k, v: count > 0 ? v : t('ingest.found.none'), found: count > 0 });
    return [
      row(t('ingest.import.identity'), read.contact.fullName ? 1 : 0, read.contact.fullName),
      row(t('ingest.import.experience'), read.experiences.length, t('ingest.found.roles', { count: read.experiences.length })),
      row(t('ingest.import.education'), read.education.length, t('ingest.found.schools', { count: read.education.length })),
      row(t('ingest.import.skills'), read.skills.length, t('ingest.found.skills', { count: read.skills.length })),
    ];
  }

  const importLabels = {
    titleScratch: t('import.title.scratch'),
    titleFile: t('import.title.file'),
    titleLinkedin: t('import.title.linkedin'),
    badgeScratch: t('import.badge.scratch'),
    badgeFile: t('import.badge.file'),
    badgeLinkedin: t('import.badge.linkedin'),
    templateClassic: t('import.template.classic'),
    templateModern: t('import.template.modern'),
    templateEditorial: t('import.template.editorial'),
    scratchHint: t('import.scratch_hint'),
    dropTitle: t('import.drop.title'),
    dropSub: t('import.drop.formats'),
    fileReady: t('import.drop.ready'),
    linkedinStepsTitle: t('import.linkedin.steps_title'),
    linkedinStep1: t('import.linkedin.step1'),
    linkedinStep2: t('import.linkedin.step2'),
    linkedinStep3: t('import.linkedin.step3'),
    linkedinUploadTitle: t('import.linkedin.upload_title'),
    linkedinUploadSub: t('import.linkedin.upload_sub'),
    linkedinReady: t('import.linkedin.ready'),
    ingestTitleScratch: t('import.ingest_title.scratch'),
    ingestTitleParse: t('import.ingest_title.parse'),
    working: t('import.working'),
    doneTitleScratch: t('import.done.title_scratch'),
    doneTitleImport: t('import.done.title_import'),
    doneBodyScratch: t('import.done.body_scratch'),
    doneBodyImport: t('import.done.body_read'),
    cancel: t('import.cancel'),
    createDraft: t('import.create_draft'),
    parseWithAi: t('import.parse_with_ai'),
    openEditor: t('import.open_editor'),
    checkResumes: t('import.check_resumes'),
    error: t('import.error'),
    demoFileName: t('import.demo_file_name'),
    demoFileSize: t('import.demo_file_size'),
  };

  // Failures where the request died in transit rather than being refused. A
  // scanned PDF parses for 45-80s, and the résumé is usually committed before
  // the response goes missing — so "try again" is the one instruction we must
  // NOT give. See LOST_RESPONSE_CODES' copy and the "check my resumes" action.
  const LOST_RESPONSE_CODES = ['network_error', 'server_error'] as const;

  // Per-code failure copy keyed by the backend error code. Covers both the
  // LinkedIn-import codes (invalid_url / fetch_failed / profile_empty /
  // url_import_not_configured) and the shared upload-parse codes; the modal
  // falls back to importLabels.error for anything unmapped.
  const importErrorMessages: Record<string, string> = {
    network_error: t('import.errors.lost_response'),
    server_error: t('import.errors.lost_response'),
    invalid_url: t('import.errors.invalid_url'),
    fetch_failed: t('import.errors.fetch_failed'),
    profile_empty: t('import.errors.profile_empty'),
    url_import_not_configured: t('import.errors.url_import_not_configured'),
    extract_failed: t('import.errors.parse_failed'),
    empty_text: t('import.errors.parse_failed'),
    parse_failed: t('import.errors.parse_failed'),
    unsupported_format: t('import.errors.unsupported_format'),
    file_too_large: t('import.errors.file_too_large'),
    file_required: t('import.errors.file_required'),
    resume_limit_reached: t('hub.slots.limit_error', { limit: BASE_RESUME_LIMIT }),
    storage_unavailable: t('hub.errors.storage_unavailable'),
    // 10 uploads a day per account (persisted server-side; 429 with Retry-After).
    rate_limited: t('hub.errors.upload_daily_limit', { limit: RESUME_UPLOADS_PER_DAY }),
    // GoApply without the AI consent: no file is read (503 ai_unavailable).
    ai_unavailable: t('hub.errors.ai_off'),
  };

  function handleSelect(method: StartMethod) {
    // Every base slot is taken: the ways to start are disabled and say so.
    if (slotsFull) return;
    setImporting({ source: method, file: null });
  }

  function handleFile(file: File) {
    if (slotsFull) return;
    setImporting({ source: 'file', file });
  }

  function handleDone(variant: RAResumeVariant) {
    setImporting(null);
    router.push(`/resume/${variant.id}`);
  }

  // Recovery after a lost response: close the modal and refetch the library, so
  // the user lands on the list that answers "did it save?" for itself.
  function handleCheckList() {
    setImporting(null);
    void refetch();
  }

  const startProps = { showLinkedIn, builderAi, onSelect: handleSelect, onFile: handleFile };

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        eyebrowLive
        // `title_after` is a suffix (".", "的履歷。", "를 만들어요."): it attaches with no space.
        title={`${joinPhrase(t('title_lead'), t('title_accent'))}${t('title_after')}`}
        sub={t('subtitle')}
      />

      <ResumeHubTabs active="resumes" />

      {/* Runs the tailor flow from `?tailor=<jobId>` / `?tailorSession=<id>` (WP-36a; mounted at the Wave 3 gate). */}
      <Suspense fallback={null}>
        <TailorLaunchHost />
      </Suspense>

      {isLoading ? (
        <div className={styles.grid} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.cardSkeleton} aria-hidden="true" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          title={t('error.title')}
          sub={t('error.sub')}
          action={
            <Btn variant="primary" onClick={() => refetch()}>
              {t('error.retry')}
            </Btn>
          }
        />
      ) : bases.length === 0 ? (
        <ResumeStart {...startProps} />
      ) : (
        <>
          {showStudio ? (
            <div className={styles.studio} data-single={tailorAvailable ? undefined : true}>
              {tailorAvailable && baseId ? (
                <TailorPanel
                  bases={bases}
                  baseId={baseId}
                  onBaseChange={setBaseChoice}
                  jobs={untailored}
                  onTailor={(jobId) => startTailoring(baseId, jobId)}
                />
              ) : null}
              <div className={styles.side}>
                <NextSteps steps={steps} loading={stepsLoading} />
                {/* Same gate as the editor's Ask button: the Assistant on, and AI allowed for this user. */}
                {tailorAvailable && assistantOn && main ? (
                  <AskAssistant onAsk={(prompt) => void openAssistant({ source: 'resume', resumeId: main.id, scope: 'resume', prompt })} />
                ) : null}
              </div>
            </div>
          ) : null}

          <section aria-labelledby="hub-library">
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle} id="hub-library">
                {t('library.title')}
              </h2>
              <BaseSlots used={bases.length} />
            </div>
            <div className={styles.grid}>
              {bases.map((r) => (
                <LibraryCard
                  key={r.id}
                  resume={r}
                  editedLabel={t('card.edited', { when: formatDate(r.lastEditedAt) })}
                  sourceLabel={sourceLabel(r)}
                  tailoredCount={tailoredPerBase.get(r.id) ?? 0}
                  primaryBusy={primaryMut.isPending}
                  onMakePrimary={() => primaryMut.mutate(r.id)}
                  onSaveTargetTitle={(title) => saveTargetTitle(r.id, title)}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleteTarget(r);
                  }}
                  onTailor={tailorAvailable ? () => startTailoring(r.id, null) : undefined}
                />
              ))}
              <NewResumeTile {...startProps} full={slotsFull} limit={BASE_RESUME_LIMIT} />
            </div>
          </section>
        </>
      )}

      {/* Tailored versions, grouped per job (not counted in the 5). */}
      {data && !isError && (bases.length > 0 || tailored.length > 0) ? (
        <section aria-labelledby="hub-tailored">
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle} id="hub-tailored">
              {t('hub.tailored.title')}
            </h2>
            <p className={styles.sectionSub}>{t('hub.tailored.sub')}</p>
          </div>
          <TailoredVersions resumes={tailored} baseNames={baseNames} formatDate={formatDate} />
        </section>
      ) : null}

      {importing && (
        <ImportModal
          source={importing.source}
          initialFile={importing.file}
          labels={importLabels}
          errorMessages={importErrorMessages}
          lostResponseCodes={LOST_RESPONSE_CODES}
          onCheckList={handleCheckList}
          ingestRows={ingestRows}
          readingLabel={(file) => t('import.reading', { file })}
          doneFacts={importFacts}
          onCreate={handleCreate}
          onClose={() => setImporting(null)}
          onDone={handleDone}
        />
      )}

      {/* AI tailoring started on this page: a saved job, or (no job) pick one or paste a posting. */}
      {tailoring ? (
        <TailorSheet
          open
          onClose={() => setTailoring(null)}
          resumeId={tailoring.resumeId}
          jobId={tailoring.jobId}
          jobTitle={tailoring.jobTitle}
          onOpenResume={(id) => router.push(`/resume/${encodeURIComponent(id)}`)}
        />
      ) : null}

      {/* Delete confirm — typed-confirm; list refetches via mutation onSuccess.
          A refused delete stays open and says why. */}
      <DeleteResumeConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        resumeName={deleteTarget?.name ?? ''}
        error={deleteError}
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
          if (!deleteTarget) return;
          setDeleteError(null);
          try {
            await deleteMut.mutateAsync(deleteTarget.id);
            setDeleteTarget(null);
          } catch (err) {
            // 409: the only base resume while saved jobs exist (RAResumeService.delete).
            setDeleteError(err instanceof RoboApiError && err.status === 409 ? t('delete.in_use') : t('delete.error'));
          }
        }}
      />
    </>
  );
}
