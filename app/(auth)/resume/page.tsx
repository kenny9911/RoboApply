'use client';

// /resume — the resume hub (WP-36b; PRODUCT_PLAN.md F-RES-02). Tabs: Resumes ·
// Cover letters (/resume/letters, WP-37). Up to 5 base resumes (Free and Pro)
// with one primary and a target title each; tailored versions are listed per
// job underneath and do not take a slot. LinkedIn means the user's own
// "Save to PDF" export only (no URL import; hidden on GoApply).
//
// Layout (source: RoboApply_V3/resume.jsx ResumeLibrary):
//   PageHeader (eyebrow + h1 + sub)
//   CreateCards   — Start from scratch / Upload a resume / Import from LinkedIn
//   SectionHead   — "Your resumes · {n} versions" + sort
//   ResumeList    — <ResumeCard> per variant (or loading / empty / error states)
//   YoungCareerTip footer
//   ImportModal   — scratch | file | linkedin → input → parsing → done → push
//
// Data: `useResumeList()` (existing) for the grid; `useCreateResumeMutation()`
// (existing) to materialize a new variant. On a successful create the modal's
// "Open editor" hands back the variant and we `router.push('/resume/[id]')` —
// Lane F owns that editor page; the route push is the ONLY coupling point.
//
// The (auth) layout already wraps children in `.main-inner`, so this page does
// NOT render its own wrapper. All strings live under the `resume` namespace.

import { Suspense, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { parseResumeMarkdown } from '../../../lib/resumeStructure';
import {
  PageHeader,
  Btn,
  EmptyState,
  IconEdit,
  IconFile,
  IconSparkle,
} from '../../../components/v3/primitives';
import {
  CreateCard,
  ResumeCard,
  ImportModal,
  joinPhrase,
  type CreateSource,
  type ImportSource,
  type ImportCreateContext,
} from '../../../components/v3/resumes';
import {
  useResumeList,
  useCreateResumeMutation,
  useUploadResumeMutation,
  useImportLinkedInMutation,
  useDeleteResumeMutation,
  useSetPrimaryResumeMutation,
} from '../../../hooks/useResumes';
import { patchResume, BASE_RESUME_LIMIT, RESUME_UPLOADS_PER_DAY, type ResumeSummary } from '../../../lib/api/resumes';
import { useQueryClient } from '@tanstack/react-query';
import { useBrand } from '../../../lib/brand';
import { DeleteResumeConfirm } from '../../../components/resumes/DeleteResumeConfirm';
import {
  BaseSlots,
  ResumeCheckEntry,
  ResumeHubMeta,
  ResumeHubTabs,
  TailoredVersions,
  isBaseSlot,
} from '../../../components/features/resume';
import { TailorLaunchHost } from '../../../components/features/tailor';
import checkStyles from '../../../components/features/resume/ResumeCheck.module.css';
import hubStyles from '../../../components/features/resume/ResumeHub.module.css';
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

function LinkedInGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M8 10v8M8 7v.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 18v-6c0-1.7 1.3-3 3-3s3 1.3 3 3v6M12 10v8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ResumesPage() {
  const t = useTranslations('resume');
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

  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [limitNotice, setLimitNotice] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<ResumeSummary | null>(null);

  const resumes = useMemo(() => data?.resumes ?? [], [data]);

  // Base resumes (they take a slot), primary first, then newest edit.
  const sorted = useMemo(() => {
    return resumes
      .filter(isBaseSlot)
      .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) || b.lastEditedAt.localeCompare(a.lastEditedAt));
  }, [resumes]);
  const tailored = useMemo(() => resumes.filter((r) => !isBaseSlot(r)), [resumes]);
  const baseNames = useMemo(() => new Map(resumes.map((r) => [r.id, r.name])), [resumes]);
  const slotsFull = sorted.length >= BASE_RESUME_LIMIT;

  // Version label: oldest created = v1, ascending. Derived (no contract field).
  const versionById = useMemo(() => {
    const byAge = [...resumes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const map = new Map<string, string>();
    byAge.forEach((r, i) => map.set(r.id, `v${i + 1}`));
    return map;
  }, [resumes]);

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '—';
    }
  }

  function editedLabel(r: ResumeSummary): string {
    return t('card.edited', { when: formatDate(r.lastEditedAt) });
  }

  async function saveTargetTitle(id: string, title: string) {
    await patchResume(id, { targetTitle: title });
    await qc.invalidateQueries({ queryKey: ['v2', 'resumes'] });
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

  function handleSelect(source: CreateSource) {
    // Every base slot is taken: say so instead of opening a doomed import.
    if (slotsFull) {
      setLimitNotice(true);
      return;
    }
    setLimitNotice(false);
    setImporting(source);
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

      {limitNotice ? (
        <p className={hubStyles.notice} role="status">
          {t('hub.slots.limit_error', { limit: BASE_RESUME_LIMIT })}
        </p>
      ) : null}

      {/* Create cards */}
      <div className="rb-create">
        <CreateCard
          source="scratch"
          icon={<IconEdit size={22} strokeWidthValue={2} />}
          title={t('create.scratch.title')}
          description={t('create.scratch.desc')}
          meta={t('create.scratch.meta')}
          onSelect={handleSelect}
        />
        <CreateCard
          source="file"
          icon={<IconFile size={22} strokeWidthValue={2} />}
          title={t('create.file.title')}
          description={t('create.file.desc')}
          meta={t('create.file.meta')}
          onSelect={handleSelect}
        />
        {showLinkedIn ? (
          <CreateCard
            source="linkedin"
            icon={<LinkedInGlyph />}
            title={t('create.linkedin.title')}
            description={t('create.linkedin.desc')}
            meta={t('create.linkedin.meta')}
            onSelect={handleSelect}
          />
        ) : null}
      </div>

      {/* Existing resumes */}
      <div className={hubStyles.sectionHead}>
        <h2 className={hubStyles.sectionTitle}>{t('library.title')}</h2>
        {data ? <BaseSlots used={sorted.length} /> : null}
      </div>

      {isLoading ? (
        <div className="rb-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rb-card"
              style={{ cursor: 'default', opacity: 0.5, minHeight: 300 }}
              aria-hidden="true"
            >
              <div className="rb-card-paper" style={{ background: 'var(--surface-2)' }} />
            </div>
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
      ) : sorted.length === 0 ? (
        <EmptyState
          title={joinPhrase(t('empty.title_lead'), t('empty.title_accent'))}
          sub={t('empty.sub')}
          action={
            <Btn variant="primary" onClick={() => handleSelect('scratch')}>
              {t('empty.cta')}
            </Btn>
          }
        />
      ) : (
        <div className="rb-list">
          {sorted.map((r) => (
            // Each card carries a Resume check entry (WP-22; F-RES-02).
            <div key={r.id} className={`${checkStyles.entryWrap} ${hubStyles.cardStack}`}>
              <ResumeCard
                resume={r}
                version={versionById.get(r.id) ?? 'v1'}
                editedLabel={editedLabel(r)}
                baseLabel={r.targetTitle ? t('hub.target.for', { title: r.targetTitle }) : t('card.base')}
                scoreUnit={t('card.score_unit')}
                onOpen={() => router.push(`/resume/${r.id}`)}
                onDelete={() => setDeleteTarget(r)}
                deleteLabel={t('card.delete')}
              />
              <ResumeHubMeta
                resume={r}
                primaryBusy={primaryMut.isPending}
                onMakePrimary={() => primaryMut.mutate(r.id)}
                onSaveTargetTitle={(title) => saveTargetTitle(r.id, title)}
              />
              <ResumeCheckEntry resumeId={r.id} name={r.name} />
            </div>
          ))}
        </div>
      )}

      {/* Tailored versions, grouped per job (not counted in the 5). */}
      {data && !isError ? (
        <section aria-labelledby="hub-tailored">
          <div className={hubStyles.sectionHead}>
            <h2 className={hubStyles.sectionTitle} id="hub-tailored">
              {t('hub.tailored.title')}
            </h2>
            <p className={hubStyles.muted}>{t('hub.tailored.sub')}</p>
          </div>
          <TailoredVersions resumes={tailored} baseNames={baseNames} formatDate={formatDate} />
        </section>
      ) : null}

      {/* Young-career coach FYI */}
      <div className="rb-foot-tip">
        <div className="iv-coach-orb" style={{ width: 26, height: 26 }} aria-hidden="true" />
        <div>
          <div className="iv-coach-lbl">{t('tip.label')}</div>
          <div
            style={{
              fontSize: 'var(--fs-meta)',
              color: 'var(--text)',
              marginTop: 4,
              lineHeight: 1.5,
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            <IconSparkle size={14} style={{ color: 'var(--action)', flexShrink: 0, marginTop: 2 }} />
            <span>{t('tip.body')}</span>
          </div>
        </div>
      </div>

      {importing && (
        <ImportModal
          source={importing}
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

      {/* Delete confirm — typed-confirm; list refetches via mutation onSuccess. */}
      <DeleteResumeConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        resumeName={deleteTarget?.name ?? ''}
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
          if (deleteTarget) await deleteMut.mutateAsync(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />
    </>
  );
}
