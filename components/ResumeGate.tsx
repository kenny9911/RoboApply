'use client';

// ResumeGate — first-run guard for the authenticated RoboApply shell.
//
// Wraps the (auth) layout shell (sibling-inner to RoboApplyAccessGate). When a
// CONFIRMED authenticated user has ZERO résumés, every authed page is replaced
// by a focused "upload your résumé to get started" prompt — EXCEPT the résumé
// library (/resumes, where the full builder lives) and the fullscreen live
// mock-interview, which are exempt so the user can always reach an upload path
// and never gets trapped.
//
// Loading-tolerant by design (mirrors RoboApplyAccessGate): we render children
// while auth is `loading` OR the résumé-count query is still resolving, and
// only block once we KNOW the user is authenticated with no résumés. This
// avoids flashing the gate at users who actually have résumés.
//
// The count query shares its key with the /resumes page's `useResumeList()`,
// so it's one cached request — and a successful upload invalidates that key,
// which flips the gate to render the real app automatically.

import { useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useAuth } from '../lib/auth/AuthProvider';
import { raV2Api } from '../lib/api/v2';
import { resumeKeys, useUploadResumeMutation } from '../hooks/useResumes';
import { IconUpload, IconCheck } from './v3/primitives';

// Keep in lockstep with the backend accepted-format list
// (DocumentParsingService) — RTF is NOT supported server-side.
const ACCEPT_RESUME = '.pdf,.doc,.docx,.txt,.md,application/pdf';

/** Map a backend upload error code → a resumeGate i18n key. Unknown/transient
 *  codes fall through to the generic message. The structured code lives on
 *  RoboApiError.payload.code (normalizeCode collapses unknown codes to
 *  'unknown', so we read the raw payload). */
function errorKeyForCode(code: unknown): string {
  switch (code) {
    case 'file_too_large':
      return 'error_too_large';
    case 'unsupported_format':
      return 'error_format';
    case 'empty_text':
      return 'error_empty';
    default:
      return 'error';
  }
}

/** Paths where the gate stands down so the user can reach an upload path. */
function isExemptPath(pathname: string): boolean {
  if (pathname === '/resumes' || pathname.startsWith('/resumes/')) return true;
  // Account/billing + plans + admin console are reachable with zero resumes
  // (admins may have none; a user must always be able to view/manage their
  // plan and buy mock-interview credits before uploading anything).
  if (pathname === '/account' || pathname.startsWith('/account/')) return true;
  if (pathname === '/plans' || pathname.startsWith('/plans/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  // Fullscreen live mock-interview (mirrors the (auth) layout detection).
  if (
    /^\/mock-interview\/[^/]+($|\/$)/.test(pathname) &&
    !pathname.endsWith('/report') &&
    !pathname.includes('/custom/')
  ) {
    return true;
  }
  return false;
}

export function ResumeGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const pathname = usePathname() ?? '';
  const exempt = isExemptPath(pathname);

  // Only fetch the count once we KNOW the user is authenticated; shares the
  // cache key with the /resumes page so there's no duplicate request.
  const resumeQuery = useQuery({
    queryKey: resumeKeys.list(),
    queryFn: () => raV2Api.resumes.list(),
    enabled: status === 'authenticated',
    staleTime: 30_000,
  });

  // Block ONLY when we positively know there are zero résumés.
  const hasNoResume = resumeQuery.isSuccess && resumeQuery.data.resumes.length === 0;
  const blocking = status === 'authenticated' && !exempt && hasNoResume;

  if (blocking) {
    return <ResumeUploadPrompt />;
  }
  return <>{children}</>;
}

function ResumeUploadPrompt() {
  const t = useTranslations('resumeGate');
  const uploadMut = useUploadResumeMutation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const busy = uploadMut.isPending;

  function onPick(file: File | null) {
    if (!file) return;
    setPicked(file);
    setErrorKey(null);
    // On a successful upload, the mutation invalidates resumeKeys.all → the
    // gate's count query refetches → this prompt unmounts and the app renders.
    uploadMut.mutate(
      { file },
      {
        onError: (err) => {
          const code =
            (err as { payload?: { code?: unknown }; code?: unknown })?.payload?.code ??
            (err as { code?: unknown })?.code;
          setErrorKey(errorKeyForCode(code));
        },
      },
    );
  }

  return (
    <div
      className="dark-canvas v3-root"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '24px',
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 460,
          textAlign: 'center',
          background: 'var(--surface, #0f1117)',
          border: '1px solid var(--border, rgba(255,255,255,0.08))',
          borderRadius: 18,
          padding: '36px 28px',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
      >
        <div
          aria-hidden="true"
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            margin: '0 auto 18px',
            display: 'grid',
            placeItems: 'center',
            background: 'var(--accent-soft, rgba(124,92,255,0.15))',
            color: 'var(--accent, #7c5cff)',
          }}
        >
          {busy ? <span className="spinner" /> : <IconUpload size={26} strokeWidthValue={2.2} />}
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 650, margin: '0 0 8px', letterSpacing: '-0.02em' }}>
          {t('title')}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--muted, #98a2b3)', margin: '0 auto 22px', maxWidth: 360, lineHeight: 1.55 }}>
          {busy ? t('uploading') : t('subtitle')}
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_RESUME}
          style={{ display: 'none' }}
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />

        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          style={{ width: '100%', justifyContent: 'center', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? (
            <>{t('uploading')}</>
          ) : (
            <>
              <IconUpload size={15} strokeWidthValue={2.2} /> {t('cta')}
            </>
          )}
        </button>

        {picked && !errorKey ? (
          <div
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: 'var(--muted, #98a2b3)',
              display: 'flex',
              gap: 6,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            {!busy && <IconCheck size={13} strokeWidthValue={3} />}
            <span style={{ fontFamily: 'var(--mono)' }}>{picked.name}</span>
          </div>
        ) : null}

        {errorKey ? (
          <p style={{ marginTop: 12, fontSize: 13, color: 'var(--warn, #f59e0b)' }} role="alert">
            {t(errorKey)}
          </p>
        ) : null}

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-2, #6b7280)' }}>{t('formats')}</div>

        <div style={{ marginTop: 18, fontSize: 13 }}>
          <a href="/resumes" style={{ color: 'var(--accent, #7c5cff)', textDecoration: 'none' }}>
            {t('or_build')}
          </a>
        </div>
      </div>
    </div>
  );
}
