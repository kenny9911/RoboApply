'use client';

// /resumes — V3 Resume builder LIBRARY (Lane E). Replaces the V2 list body.
//
// Layout (source: RoboApply_V3/resume.jsx ResumeLibrary):
//   PageHeader (eyebrow + serif-accent h1 + sub)
//   CreateCards   — Start from scratch / Upload a resume / Import from LinkedIn
//   SectionHead   — "Your resumes · {n} versions" + sort
//   ResumeList    — <ResumeCard> per variant (or loading / empty / error states)
//   YoungCareerTip footer
//   ImportModal   — scratch | file | linkedin → input → parsing → done → push
//
// Data: `useResumeList()` (existing) for the grid; `useCreateResumeMutation()`
// (existing) to materialize a new variant. On a successful create the modal's
// "Open editor" hands back the variant and we `router.push('/resumes/[id]')` —
// Lane F owns that editor page; the route push is the ONLY coupling point.
//
// The (auth) layout already wraps children in `.main-inner`, so this page does
// NOT render its own wrapper. All strings live under the `resumes` namespace.

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

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
  type CreateSource,
  type ImportSource,
  type ImportCreateContext,
} from '../../../components/v3/resumes';
import {
  useResumeList,
  useCreateResumeMutation,
  useUploadResumeMutation,
  useImportLinkedInMutation,
  useLinkedInImportConfig,
  useDeleteResumeMutation,
} from '../../../hooks/useResumes';
import { DeleteResumeConfirm } from '../../../components/resumes/DeleteResumeConfirm';
import type {
  RAResumeVariant,
  RAResumeVariantSummary,
  ResumeCreateBody,
} from '../../../lib/api/v2/types';

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
  const t = useTranslations('resumes');
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useResumeList();
  const createMut = useCreateResumeMutation();
  const uploadMut = useUploadResumeMutation();
  const importLinkedInMut = useImportLinkedInMutation();
  const linkedinConfig = useLinkedInImportConfig();
  const deleteMut = useDeleteResumeMutation();

  const [importing, setImporting] = useState<ImportSource | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<RAResumeVariantSummary | null>(null);

  const resumes = data?.resumes ?? [];

  // Sort newest-edited first for display.
  const sorted = useMemo(() => {
    return [...resumes].sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
  }, [resumes]);

  // Version label: oldest created = v1, ascending. Derived (no contract field).
  const versionById = useMemo(() => {
    const byAge = [...resumes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const map = new Map<string, string>();
    byAge.forEach((r, i) => map.set(r.id, `v${i + 1}`));
    return map;
  }, [resumes]);

  function editedLabel(r: RAResumeVariantSummary): string {
    let when: string;
    try {
      when = new Date(r.lastEditedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      when = '—';
    }
    return t('card.edited', { when });
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
    // LinkedIn import — a "Save to PDF" file (pdf mode) or a public profile URL
    // (url mode, only reachable when the URL field is enabled). Parses for real.
    if (ctx.source === 'linkedin') {
      return importLinkedInMut.mutateAsync({
        mode: ctx.file ? 'pdf' : 'url',
        file: ctx.file ?? undefined,
        linkedinUrl: ctx.linkedinUrl || undefined,
      });
    }
    return createMut.mutateAsync(buildCreateBody(ctx));
  }

  // Per-source cosmetic ingest rows shown during the "parsing" animation.
  function ingestRows(source: ImportSource, ctx: ImportCreateContext) {
    if (source === 'scratch') {
      return [
        { k: t('ingest.scratch.template'), v: t('ingest.scratch.template_v') },
        { k: t('ingest.scratch.sections'), v: t('ingest.scratch.sections_v') },
        { k: t('ingest.scratch.ai'), v: t('ingest.scratch.ai_v') },
        { k: t('ingest.scratch.ready'), v: t('ingest.scratch.ready_v') },
      ];
    }
    const readValue =
      source === 'file'
        ? (ctx.fileName ?? t('import.demo_file_name'))
        : (ctx.fileName ?? ctx.linkedinUrl) || 'linkedin.com/in/you';
    return [
      { k: t('ingest.import.read'), v: readValue },
      { k: t('ingest.import.identity'), v: t('ingest.import.identity_v') },
      { k: t('ingest.import.experience'), v: t('ingest.import.experience_v') },
      { k: t('ingest.import.education'), v: t('ingest.import.education_v') },
      { k: t('ingest.import.skills'), v: t('ingest.import.skills_v') },
      { k: t('ingest.import.cleaned'), v: t('ingest.import.cleaned_v') },
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
    dropSub: t('import.drop.sub'),
    fileReady: t('import.drop.ready'),
    linkedinStepsTitle: t('import.linkedin.steps_title'),
    linkedinStep1: t('import.linkedin.step1'),
    linkedinStep2: t('import.linkedin.step2'),
    linkedinStep3: t('import.linkedin.step3'),
    linkedinUploadTitle: t('import.linkedin.upload_title'),
    linkedinUploadSub: t('import.linkedin.upload_sub'),
    linkedinReady: t('import.linkedin.ready'),
    linkedinOr: t('import.linkedin.or'),
    linkedinUrlLabel: t('import.linkedin.url_label'),
    linkedinPlaceholder: t('import.linkedin.placeholder'),
    linkedinHint: t('import.linkedin.hint'),
    ingestTitleScratch: t('import.ingest_title.scratch'),
    ingestTitleParse: t('import.ingest_title.parse'),
    working: t('import.working'),
    doneTitleScratch: t('import.done.title_scratch'),
    doneTitleImport: t('import.done.title_import'),
    doneBodyScratch: t('import.done.body_scratch'),
    doneBodyImport: t('import.done.body_import'),
    cancel: t('import.cancel'),
    createDraft: t('import.create_draft'),
    parseWithAi: t('import.parse_with_ai'),
    openEditor: t('import.open_editor'),
    error: t('import.error'),
    demoFileName: t('import.demo_file_name'),
    demoFileSize: t('import.demo_file_size'),
  };

  // Per-code failure copy keyed by the backend error code. Covers both the
  // LinkedIn-import codes (invalid_url / fetch_failed / profile_empty /
  // url_import_not_configured) and the shared upload-parse codes; the modal
  // falls back to importLabels.error for anything unmapped.
  const importErrorMessages: Record<string, string> = {
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
  };

  function handleSelect(source: CreateSource) {
    setImporting(source);
  }

  function handleDone(variant: RAResumeVariant) {
    setImporting(null);
    router.push(`/resumes/${variant.id}`);
  }

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        eyebrowLive
        title={t('title_lead')}
        accentWord={t('title_accent')}
        titleAfter={t('title_after')}
        sub={t('subtitle')}
      />

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
        <CreateCard
          source="linkedin"
          icon={<LinkedInGlyph />}
          title={t('create.linkedin.title')}
          description={t('create.linkedin.desc')}
          meta={t('create.linkedin.meta')}
          onSelect={handleSelect}
        />
      </div>

      {/* Existing resumes */}
      <div className="rb-section-head">
        <div className="iv-section-label" style={{ marginBottom: 0 }}>
          <span>{t('section.title')}</span>
          <span style={{ color: 'var(--muted)' }}>
            {t('section.count', { count: resumes.length })}
          </span>
        </div>
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
          title={t('empty.title_lead')}
          accentWord={t('empty.title_accent')}
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
            <ResumeCard
              key={r.id}
              resume={r}
              version={versionById.get(r.id) ?? 'v1'}
              editedLabel={editedLabel(r)}
              baseLabel={t('card.base')}
              scoreUnit={t('card.score_unit')}
              onOpen={() => router.push(`/resumes/${r.id}`)}
              onDelete={() => setDeleteTarget(r)}
              deleteLabel={t('card.delete')}
            />
          ))}
        </div>
      )}

      {/* Young-career coach FYI */}
      <div className="rb-foot-tip">
        <div className="iv-coach-orb" style={{ width: 26, height: 26 }} aria-hidden="true" />
        <div>
          <div className="iv-coach-lbl">{t('tip.label')}</div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--text)',
              marginTop: 4,
              lineHeight: 1.5,
              display: 'flex',
              gap: 6,
              alignItems: 'flex-start',
              flexWrap: 'wrap',
            }}
          >
            <IconSparkle size={14} style={{ color: 'var(--accent-text)', flexShrink: 0, marginTop: 2 }} />
            <span>{t('tip.body')}</span>
          </div>
        </div>
      </div>

      {importing && (
        <ImportModal
          source={importing}
          labels={importLabels}
          linkedinUrlEnabled={linkedinConfig.data?.urlImportEnabled ?? false}
          errorMessages={importErrorMessages}
          ingestRows={ingestRows}
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
