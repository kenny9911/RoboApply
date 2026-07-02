'use client';

// ResumeSelectPanel — S0 of the onboarding chat. Three ways in:
//   • pick an existing resume variant (newest first, primary preselected),
//   • upload a new file (the reworked UploadStep drop zone — truthful
//     accept list, no fake parse claims),
//   • paste raw resume text (creates a base variant),
//   • + a conditional LinkedIn URL import when the deployment enables it.
// Whichever path produces a variant id, the page kicks off the bootstrap
// and flips to the chat phase.

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { IconCheck, IconUpload } from '../primitives/Iconset';
import {
  useCreateResumeMutation,
  useImportLinkedInMutation,
  useLinkedInImportConfig,
  useResumeList,
  useUploadResumeMutation,
} from '../../../hooks/useResumes';
import { RoboApiError } from '../../../lib/api/client';
import { UploadStep } from './UploadStep';

type PanelMode = 'list' | 'upload' | 'paste';

interface Props {
  /** A variant is ready — bootstrap the chat with it. */
  onReady: (resumeVariantId: string) => void;
  /** Bootstrap in flight — lock the CTAs. */
  busy: boolean;
  /** Bootstrap-level error to surface (e.g. 'daily_limit'). */
  errorCode?: string | null;
}

/** Map an upload/create failure to a localized recovery message key. */
function uploadErrorKey(err: unknown): string {
  if (err instanceof RoboApiError) {
    const raw = (err.payload as { code?: string } | undefined)?.code;
    if (raw === 'file_too_large') return 'error_file_too_large';
    if (raw === 'unsupported_format') return 'error_unsupported_format';
  }
  return 'error_parse_failed';
}

export function ResumeSelectPanel({ onReady, busy, errorCode }: Props) {
  const t = useTranslations('onboarding.resumeSelect');
  const tChat = useTranslations('onboarding.chat');
  const locale = useLocale();

  const resumeList = useResumeList();
  const linkedinConfig = useLinkedInImportConfig();
  const uploadResume = useUploadResumeMutation();
  const createResume = useCreateResumeMutation();
  const importLinkedIn = useImportLinkedInMutation();

  const variants = resumeList.data?.resumes ?? [];

  const [mode, setMode] = useState<PanelMode>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedFile, setPickedFile] = useState<{ name: string; size: string } | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [localErrorKey, setLocalErrorKey] = useState<string | null>(null);

  // Preselect the primary variant (else the newest) once the list lands;
  // with zero variants the upload zone is the only sensible default.
  useEffect(() => {
    if (!resumeList.isSuccess) return;
    if (variants.length === 0) {
      setMode((cur) => (cur === 'list' ? 'upload' : cur));
      return;
    }
    setSelectedId((cur) => {
      if (cur && variants.some((v) => v.id === cur)) return cur;
      return (variants.find((v) => v.isPrimary) ?? variants[0]).id;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeList.isSuccess, resumeList.data]);

  function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function handlePick(picked: File | null) {
    if (!picked || busy) return;
    setLocalErrorKey(null);
    setPickedFile({ name: picked.name, size: humanSize(picked.size) });
    try {
      const created = await uploadResume.mutateAsync({ file: picked });
      onReady(created.id);
    } catch (err) {
      setPickedFile(null);
      setLocalErrorKey(uploadErrorKey(err));
    }
  }

  async function handlePasteSubmit() {
    const text = pasteText.trim();
    if (!text || busy) return;
    setLocalErrorKey(null);
    try {
      const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const created = await createResume.mutateAsync({
        kind: 'base',
        name: heading || t('paste_name'),
        resumeMarkdown: text,
      });
      onReady(created.id);
    } catch (err) {
      setLocalErrorKey(uploadErrorKey(err));
    }
  }

  async function handleLinkedInSubmit() {
    const url = linkedinUrl.trim();
    if (!url || busy) return;
    setLocalErrorKey(null);
    try {
      const created = await importLinkedIn.mutateAsync({
        mode: 'url',
        linkedinUrl: url,
      });
      onReady(created.id);
    } catch (err) {
      setLocalErrorKey(uploadErrorKey(err));
    }
  }

  const pending =
    busy ||
    uploadResume.isPending ||
    createResume.isPending ||
    importLinkedIn.isPending;

  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const errorLine = localErrorKey
    ? t(localErrorKey)
    : errorCode === 'daily_limit'
      ? tChat('error_daily_limit')
      : errorCode
        ? t('error_parse_failed')
        : null;

  return (
    <div style={{ width: '100%', maxWidth: 640, textAlign: 'left' }}>
      <h1 style={{ textAlign: 'center' }}>
        {t('title')} <em>{t('title_accent')}</em>
        {t('title_after')}
      </h1>
      <p className="lead" style={{ textAlign: 'center' }}>
        {t('lead')}
      </p>

      {errorLine ? (
        <p role="alert" style={{ color: 'var(--warn)', fontSize: 13.5, marginBottom: 12 }}>
          {errorLine}
        </p>
      ) : null}

      {mode === 'list' ? (
        <>
          {/* ── Existing variants (newest first; primary preselected) ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} role="radiogroup" aria-label={t('title')}>
            {variants.map((variant) => {
              const active = variant.id === selectedId;
              return (
                <button
                  key={variant.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelectedId(variant.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 16px',
                    borderRadius: 12,
                    border: active
                      ? '2px solid var(--accent)'
                      : '1px solid var(--rule)',
                    background: 'var(--surface-2)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border: active
                        ? '5px solid var(--accent)'
                        : '2px solid var(--rule)',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14.5, color: 'var(--text)' }}>
                      {variant.name}
                      {variant.isPrimary ? (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 10.5,
                            fontFamily: 'var(--mono)',
                            color: 'var(--accent-text)',
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                          }}
                        >
                          ★ {t('primary_badge')}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                      {t('last_edited', {
                        date: dateFormatter.format(new Date(variant.lastEditedAt)),
                      })}
                    </div>
                  </div>
                  {active ? <IconCheck size={16} strokeWidthValue={3} /> : null}
                </button>
              );
            })}
          </div>

          {/* ── Upload-new tile + paste link ── */}
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setMode('upload')}
              disabled={pending}
            >
              <IconUpload size={14} /> {t('upload_new')}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setMode('paste')}
              disabled={pending}
            >
              {t('paste_text')}
            </button>
          </div>

          <div style={{ marginTop: 22, textAlign: 'center' }}>
            <button
              type="button"
              className="btn primary"
              disabled={!selectedId || pending}
              onClick={() => selectedId && onReady(selectedId)}
            >
              {t('continue')}
            </button>
          </div>
        </>
      ) : null}

      {mode === 'upload' ? (
        <>
          <UploadStep
            file={pickedFile}
            extracted={[]}
            totalRows={0}
            onPick={(f) => void handlePick(f)}
            error={null}
          />
          {/* Conditional LinkedIn URL import (deployment-gated). */}
          {linkedinConfig.data?.urlImportEnabled ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <input
                type="url"
                className="intent-input"
                style={{ minHeight: 0, padding: '10px 12px', flex: 1 }}
                placeholder={t('linkedin_placeholder')}
                aria-label={t('linkedin_import')}
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn ghost"
                disabled={!linkedinUrl.trim() || pending}
                onClick={() => void handleLinkedInSubmit()}
              >
                {t('linkedin_import')}
              </button>
            </div>
          ) : null}
          {localErrorKey ? (
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button type="button" className="btn ghost" onClick={() => setLocalErrorKey(null)}>
                {t('retry')}
              </button>
              {variants.length > 0 ? (
                <button type="button" className="btn ghost" onClick={() => setMode('list')}>
                  {t('pick_existing')}
                </button>
              ) : null}
              <button type="button" className="btn ghost" onClick={() => setMode('paste')}>
                {t('paste_instead')}
              </button>
            </div>
          ) : null}
          {variants.length > 0 ? (
            <button
              type="button"
              className="btn ghost"
              style={{ marginTop: 14 }}
              onClick={() => setMode('list')}
            >
              {t('back')}
            </button>
          ) : null}
        </>
      ) : null}

      {mode === 'paste' ? (
        <>
          <textarea
            className="intent-input"
            style={{ minHeight: 220 }}
            value={pasteText}
            placeholder={t('paste_placeholder')}
            aria-label={t('paste_text')}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              className="btn primary"
              disabled={!pasteText.trim() || pending}
              onClick={() => void handlePasteSubmit()}
            >
              {t('paste_submit')}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode(variants.length > 0 ? 'list' : 'upload')}>
              {t('back')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
