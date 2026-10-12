'use client';

// CoverLetterEditor — /resume/letters/[id] (WP-37; PRODUCT_PLAN.md F-CL-02).
//
// Edit (autosaved; each pause is a version), rewrite with AI (20/day/letter,
// no credit), a new version in another tone or length (credit), where each
// sentence comes from (Sources), version restore, copy, PDF/Word download and
// attach to an application. Every AI block is labelled "Written from the job
// post and your resume." and, on GoApply, carries AiGeneratedBadge. The
// letter is never sent by us (D1).

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

import { Btn, Modal, PageHeader, Tabs, tabPanelProps, toast } from '../../v3/primitives';
import { useCoverLetter, useLetterActions, useLetterEditor, type LetterErrorKind, type LetterResult } from '../../../hooks/coverletter/useCoverLetters';
import { coverLetterExportUrl } from '../../../lib/api/coverLetters';
import { AiGeneratedBadge } from '../market';
import { WechatBrowserBanner } from '../auth-cn';
import { LetterError } from './LetterError';
import { RewritePanel, SourcesPanel, VersionsPanel } from './LetterPanels';
import { COVER_LETTERS_HREF } from './links';
import styles from './CoverLetter.module.css';

type Tab = 'letter' | 'rewrite' | 'sources' | 'versions';

export interface CoverLetterEditorProps {
  letterId: string;
  /** An application to offer "Attach to this application" for (from `?entry=`). */
  trackerEntryId?: string | null;
}

export function CoverLetterEditor({ letterId, trackerEntryId }: CoverLetterEditorProps) {
  const t = useTranslations('coverLetter');
  const router = useRouter();
  const query = useCoverLetter(letterId);
  const letter = query.data;
  const editor = useLetterEditor(letter);
  const actions = useLetterActions(letterId);
  const [tab, setTab] = useState<Tab>('letter');
  const [aiError, setAiError] = useState<{ kind: LetterErrorKind; cause?: unknown } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (query.isLoading) {
    return (
      <p className={styles.muted} role="status">
        {t('editor.loading')}
      </p>
    );
  }
  if (!letter) {
    return (
      <div className={styles.page}>
        <a href={COVER_LETTERS_HREF} className={styles.backLink}>
          {t('editor.back')}
        </a>
        <LetterError kind="not_found" />
      </div>
    );
  }

  const title = letter.title || t('hub.untitled');

  const handle = (r: LetterResult, done: string) => {
    if (r.ok) {
      setAiError(null);
      toast({ message: done, tone: 'ok' });
      setTab('letter');
    } else {
      setAiError({ kind: r.error, cause: r.cause });
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(editor.text);
      toast({ message: t('editor.copied'), tone: 'ok' });
    } catch {
      toast({ message: t('editor.copyFailed'), tone: 'danger' });
    }
  };

  const download = async (format: 'pdf' | 'docx') => {
    await editor.flush();
    const attachedEntry = letter.trackerEntryId ?? undefined;
    window.location.assign(coverLetterExportUrl(letter.id, { format, ...(attachedEntry ? { trackerEntryId: attachedEntry } : {}) }));
  };

  const attach = async (entry: string | null) => {
    const r = await actions.attach(entry);
    if (!r.ok) toast({ message: t('editor.attachFailed'), tone: 'danger' });
  };

  const remove = async () => {
    const ok = await actions.remove();
    setConfirmDelete(false);
    if (ok) router.push(COVER_LETTERS_HREF);
    else toast({ message: t('editor.deleteFailed'), tone: 'danger' });
  };

  const tabs = [
    { id: 'letter' as const, label: t('editor.tabLetter') },
    { id: 'rewrite' as const, label: t('editor.tabRewrite') },
    { id: 'sources' as const, label: t('editor.tabSources') },
    { id: 'versions' as const, label: t('editor.tabVersions'), count: letter.versions.length },
  ];

  const saveLine =
    editor.state === 'saving'
      ? t('editor.saving')
      : editor.state === 'error'
        ? t('editor.saveError')
        : editor.dirty
          ? t('editor.unsaved')
          : editor.state === 'saved'
            ? t('editor.saved')
            : '';

  return (
    <div className={styles.page}>
      <a href={COVER_LETTERS_HREF} className={styles.backLink}>
        {t('editor.back')}
      </a>
      <PageHeader eyebrow={t('hub.title')} title={title} />

      <p className={styles.labelLine}>
        <span>{t('ai.label')}</span>
        <AiGeneratedBadge kind="document" />
      </p>
      <p className={styles.muted}>{t('form.neverSent')}</p>

      {letter.trackerEntryId ? (
        <div className={styles.row}>
          <span className={styles.body}>{t('editor.attached')}</span>
          <Btn variant="ghost" onClick={() => void attach(null)} disabled={actions.pending === 'attach'}>
            {t('editor.detach')}
          </Btn>
        </div>
      ) : trackerEntryId ? (
        <div className={styles.row}>
          <Btn onClick={() => void attach(trackerEntryId)} disabled={actions.pending === 'attach'}>
            {t('editor.attach')}
          </Btn>
        </div>
      ) : null}

      <Tabs ariaLabel={t('editor.tabs')} idBase="cover-letter" value={tab} onChange={setTab} tabs={tabs} />

      <div {...tabPanelProps('cover-letter', 'letter')} hidden={tab !== 'letter'} className={styles.stack}>
        <label className={styles.field}>
          <span className={styles.label}>{t('editor.bodyLabel')}</span>
          <textarea className={styles.paper} value={editor.text} onChange={(e) => editor.change(e.target.value)} onBlur={() => void editor.flush()} maxLength={20_000} spellCheck />
        </label>
        <p className={editor.state === 'error' ? styles.statusError : styles.status} role="status" aria-live="polite">
          {saveLine}
        </p>
        <WechatBrowserBanner action="download" />
        {letter.pdfAvailable ? null : (
          <p id="cl-pdf-note" className={styles.notice}>
            {t('editor.pdfUnavailable')}
          </p>
        )}
        <div className={styles.actions}>
          <Btn onClick={() => void copy()}>{t('editor.copy')}</Btn>
          <Btn onClick={() => void download('pdf')} disabled={!letter.pdfAvailable} aria-describedby={letter.pdfAvailable ? undefined : 'cl-pdf-note'}>
            {t('editor.downloadPdf')}
          </Btn>
          <Btn onClick={() => void download('docx')}>{t('editor.downloadWord')}</Btn>
          <Btn variant="ghost" onClick={() => setConfirmDelete(true)}>
            {t('editor.delete')}
          </Btn>
        </div>
      </div>

      <div {...tabPanelProps('cover-letter', 'rewrite')} hidden={tab !== 'rewrite'}>
        <RewritePanel
          letter={letter}
          pending={actions.pending}
          error={aiError}
          creditBucket={actions.summary}
          onRewrite={async (instruction) => {
            await editor.flush();
            handle(await actions.rewrite(instruction), t('rewrite.done'));
          }}
          onRegenerate={async (body) => {
            await editor.flush();
            handle(await actions.regenerate(body), t('rewrite.newVersionDone'));
          }}
        />
      </div>

      <div {...tabPanelProps('cover-letter', 'sources')} hidden={tab !== 'sources'}>
        <SourcesPanel letter={letter} />
      </div>

      <div {...tabPanelProps('cover-letter', 'versions')} hidden={tab !== 'versions'}>
        <VersionsPanel
          letter={letter}
          pending={actions.pending === 'restore'}
          onRestore={async (index) => {
            await editor.flush();
            const r = await actions.restore(index);
            if (r.ok) {
              toast({ message: t('versions.restored'), tone: 'ok' });
              setTab('letter');
            } else toast({ message: t(`error.${r.error === 'rewrite_limit' ? 'failed' : r.error}`), tone: 'danger' });
          }}
        />
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('editor.deleteTitle')}
        description={t('editor.deleteBody')}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('form.cancel')}
            </Btn>
            <Btn variant="primary" onClick={() => void remove()} disabled={actions.pending === 'remove'}>
              {t('editor.deleteConfirm')}
            </Btn>
          </>
        }
      >
        <span />
      </Modal>
    </div>
  );
}
