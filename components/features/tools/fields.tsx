'use client';

// Form pieces shared by the two free tools (WP-57): the file picker (native
// input, 44 px label button, client-side type/size check), the GoApply
// processing notice, and today's allowance line.

import Link from 'next/link';
import { useId, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';

import type { ToolKind, ToolsConfigView } from '../../../lib/api/contracts/tools';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { CLIENT_LIMITS } from './catalog';
import styles from './tools.module.css';

export type FileCheck = 'ok' | 'file_wrong_type' | 'file_too_large';

export function checkFile(file: File, config?: Pick<ToolsConfigView, 'acceptedExtensions' | 'maxFileBytes'> | null): FileCheck {
  const exts = config?.acceptedExtensions ?? CLIENT_LIMITS.acceptedExtensions;
  const max = config?.maxFileBytes ?? CLIENT_LIMITS.maxFileBytes;
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(file.name)?.[0]?.toLowerCase() ?? '';
  if (!exts.includes(ext)) return 'file_wrong_type';
  if (file.size > max) return 'file_too_large';
  return 'ok';
}

export interface FileFieldProps {
  file: File | null;
  onChange: (file: File | null, problem: FileCheck) => void;
  config?: ToolsConfigView | null;
  disabled?: boolean;
}

export function FileField({ file, onChange, config, disabled }: FileFieldProps) {
  const t = useTranslations('tools');
  const id = useId();
  const hintId = `${id}-hint`;
  const exts = config?.acceptedExtensions ?? CLIENT_LIMITS.acceptedExtensions;
  const mb = Math.round((config?.maxFileBytes ?? CLIENT_LIMITS.maxFileBytes) / (1024 * 1024));

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null;
    onChange(next, next ? checkFile(next, config) : 'ok');
  };

  return (
    <div className={styles.field}>
      <span className={styles.label} id={`${id}-label`}>
        {t('upload.label')}
      </span>
      <div className={styles.fileRow}>
        <input
          id={id}
          className={styles.fileInput}
          type="file"
          name="resume"
          accept={exts.join(',')}
          onChange={pick}
          disabled={disabled}
          aria-labelledby={`${id}-label ${id}-button`}
          aria-describedby={hintId}
          data-testid="tool-file"
        />
        <label htmlFor={id} className={styles.fileButton} id={`${id}-button`}>
          {file ? t('upload.replace') : t('upload.choose')}
        </label>
        <span className={styles.fileName} aria-live="polite">
          {file ? t('upload.selected', { name: file.name }) : t('upload.none')}
        </span>
      </div>
      <p className={styles.muted} id={hintId}>
        {t('upload.hint', { mb })}
      </p>
    </div>
  );
}

export interface ConsentFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** GET /config; null when it did not answer (the notice then points to the privacy notice for where it is processed). */
  config: Pick<ToolsConfigView, 'processedOutsideMainland' | 'parserName'> | null;
  hours: number;
  disabled?: boolean;
}

/**
 * GoApply: the visitor's go-ahead to read this file (unticked by default).
 * Says who reads it (the outside resume-reading service, when one is active)
 * and where (outside mainland China during the offshore beta).
 */
export function ConsentField({ checked, onChange, config, hours, disabled }: ConsentFieldProps) {
  const t = useTranslations('tools');
  const brand = useBrand();
  const detailsId = useId();
  const privacyHref = brand.legal.privacyPath;
  const details: string[] = [];
  if (config) {
    if (config.parserName) details.push(t('consent.readingService', { service: config.parserName }));
    if (config.processedOutsideMainland) details.push(t('consent.offshore'));
  } else {
    details.push(t('consent.whereUnknown'));
  }
  return (
    <div className={styles.field} data-consent="tools">
      <label className={styles.consent}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} aria-describedby={detailsId} />
        <span>{t('consent.label', { hours })}</span>
      </label>
      <p className={styles.muted} id={detailsId}>
        {details.length ? `${details.join(' ')} ` : ''}
        <Link href={privacyHref}>{t('consent.privacyLink')}</Link>
      </p>
    </div>
  );
}

/** "2 free checks left today" for this tool — only once the server has said so (unknown is not 0). */
export function AllowanceLine({ config, kind }: { config: ToolsConfigView | null | undefined; kind: ToolKind }) {
  const t = useTranslations('tools');
  // Unknown until the server answers (RATE_LIMITS_JSON may change it): no number shown.
  if (!config) return null;
  const left = config.remainingByTool?.[kind] ?? null;
  if (left === null) return <p className={styles.muted}>{t('allowance.limit', { limit: config.perIpPerDay })}</p>;
  return (
    <p className={styles.muted} data-remaining={left}>
      {t('allowance.left', { count: left })}
    </p>
  );
}
