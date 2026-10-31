'use client';

// Ways to start a resume on the /resume hub (WP-36b; F-RES-02, F-RES-17):
//   <NewResumeTile />   the last cell of the library grid
//   <ResumeStart />     the first visit, before there is any resume
// Both offer: upload a file (it can also be dropped on the panel), the guided
// builder at /resume/new, a template, and the user's own LinkedIn PDF (not on
// GoApply). Every base slot taken: the tile says so and the ways are disabled
// rather than opening an import that would be refused.

import Link from 'next/link';
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { IconEdit, IconFile, IconSparkle, IconUpload } from '../../../v3/primitives';
import styles from './Hub.module.css';

export type StartMethod = 'file' | 'scratch' | 'linkedin';

/** The guided builder (WP-65). */
export const BUILDER_HREF = '/resume/new';

interface CommonProps {
  /** The LinkedIn PDF way (RoboApply only). */
  showLinkedIn: boolean;
  /** The builder offers AI writing help to this user (builder config). */
  builderAi: boolean;
  onSelect: (method: StartMethod) => void;
  /** A file dropped on the panel. */
  onFile: (file: File) => void;
}

function LinkedInGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10v8M8 7v.01" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 18v-6c0-1.7 1.3-3 3-3s3 1.3 3 3v6M12 10v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Drop handlers for a panel that takes a resume file, and whether one is over it. */
function useFileDrop(onFile: (file: File) => void, enabled: boolean) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child; count them so the highlight holds.
  const depth = useRef(0);
  if (!enabled) return { dragging: false, handlers: {} };
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
  };
  return { dragging, handlers };
}

function Method({
  icon,
  title,
  desc,
  tag,
  disabled,
  onClick,
  href,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  tag?: string | null;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const body = (
    <>
      <span className={styles.methodIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={styles.methodText}>
        <span className={styles.methodTitle}>
          {title}
          {tag ? (
            <span className={styles.aiTag}>
              <IconSparkle size={12} aria-hidden="true" />
              {tag}
            </span>
          ) : null}
        </span>
        <span className={styles.methodDesc}>{desc}</span>
      </span>
    </>
  );
  if (href && !disabled) {
    return (
      <Link className={styles.method} href={href}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" className={styles.method} onClick={onClick} disabled={disabled}>
      {body}
    </button>
  );
}

function Methods({ showLinkedIn, builderAi, onSelect, disabled, withUpload }: Omit<CommonProps, 'onFile'> & { disabled?: boolean; withUpload: boolean }) {
  const t = useTranslations('resume.hub.new');
  return (
    <ul className={styles.methodList}>
      {withUpload ? (
        <li>
          <Method icon={<IconUpload size={18} />} title={t('upload.title')} desc={t('upload.desc')} disabled={disabled} onClick={() => onSelect('file')} />
        </li>
      ) : null}
      <li>
        <Method icon={<IconEdit size={18} />} title={t('builder.title')} desc={t('builder.desc')} tag={builderAi ? t('ai_help') : null} disabled={disabled} href={BUILDER_HREF} />
      </li>
      <li>
        <Method icon={<IconFile size={18} />} title={t('template.title')} desc={t('template.desc')} disabled={disabled} onClick={() => onSelect('scratch')} />
      </li>
      {showLinkedIn ? (
        <li>
          <Method icon={<LinkedInGlyph />} title={t('linkedin.title')} desc={t('linkedin.desc')} disabled={disabled} onClick={() => onSelect('linkedin')} />
        </li>
      ) : null}
    </ul>
  );
}

export interface NewResumeTileProps extends CommonProps {
  /** Every base slot is taken. */
  full: boolean;
  limit: number;
}

/** The library's last cell: start another resume. */
export function NewResumeTile({ full, limit, onFile, ...methods }: NewResumeTileProps) {
  const t = useTranslations('resume.hub');
  const titleId = useId();
  const { dragging, handlers } = useFileDrop(onFile, !full);
  return (
    <section className={styles.newTile} aria-labelledby={titleId} data-dragging={dragging || undefined} {...handlers}>
      <h3 className={styles.newTitle} id={titleId}>
        {t('new.title')}
      </h3>
      {full ? <p className={styles.limit}>{t('slots.limit_error', { limit })}</p> : <p className={styles.newHint}>{t('new.hint')}</p>}
      <Methods {...methods} disabled={full} withUpload />
    </section>
  );
}

/** First visit: no resume yet. Upload is the main way; the rest sit beside it. */
export function ResumeStart({ onFile, ...methods }: CommonProps) {
  const t = useTranslations('resume.hub.start');
  const tImport = useTranslations('resume.import');
  const titleId = useId();
  const sideId = useId();
  const { dragging, handlers } = useFileDrop(onFile, true);
  return (
    <section className={styles.start} aria-labelledby={titleId} {...handlers}>
      <div>
        <h2 className={styles.startTitle} id={titleId}>
          {t('title')}
        </h2>
        <p className={styles.startBody}>{t('body')}</p>
      </div>
      <div className={styles.startGrid}>
        <button type="button" className={styles.drop} data-dragging={dragging || undefined} onClick={() => methods.onSelect('file')}>
          <span className={styles.dropIcon} aria-hidden="true">
            <IconUpload size={22} />
          </span>
          <span className={styles.dropTitle}>{t('drop_title')}</span>
          <span className={styles.dropBody}>{t('drop_body')}</span>
          <span className={styles.dropFormats}>{tImport('drop.formats')}</span>
        </button>
        <div className={styles.startSide} role="group" aria-labelledby={sideId}>
          <p className={styles.jobsLabel} id={sideId}>
            {t('or')}
          </p>
          <Methods {...methods} withUpload={false} />
        </div>
      </div>
      <ol className={styles.how}>
        {(['read', 'check', 'tailor'] as const).map((step, i) => (
          <li key={step}>
            <span className={styles.howNum} aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <span className={styles.howTitle}>{t(`how.${step}_title`)}</span>
              <span className={styles.howBody}>{t(`how.${step}_body`)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
