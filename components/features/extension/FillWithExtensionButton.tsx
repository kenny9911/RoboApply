'use client';

// FillWithExtensionButton — "Fill this form" from a job (PRODUCT_PLAN.md
// §5.17; R-11; ruling C27). Rendered by WP-34's "Get ready for this job"
// checklist behind the `extension` flag.
//
//   - Shown only where an adapter exists for the job's application form
//     (`autofill.supported` from job detail, read from the job query the
//     page already holds: the brand's market list AND an application URL on
//     a host the adapter runs on; AND the ATS is on this brand's own list and
//     is not a page-by-page form — Workday, iCIMS, Taleo, SuccessFactors
//     wait for R4, WP-93) and the brand has a published extension.
//   - Extension installed → "Fill this form" opens the employer's application
//     page in a new tab; the extension fills it there, and the user checks
//     every field and submits it (D1).
//   - Not installed (desktop Chromium) → "Get the extension to fill this form" → /extension.
//   - Phones, tablets and other browsers → nothing (the extension cannot run).
//
// Opening the page does NOT move the job to Applied: only the user's answer
// to the extension's "Did you submit this application?" does. Nothing here
// reads the page or asks for a fit score.

import { useTranslations } from 'next-intl';

import { useJob } from '../../../hooks/job';
import { extensionFillsAts, useExtensionPresence } from '../../../hooks/extension';
import { useBrandId } from '../../../lib/brand/BrandProvider';
import s from './extension.module.css';

export interface FillWithExtensionButtonProps {
  jobId: string;
  /** The employer's application URL; null when the job has none (the button stays hidden). */
  applyUrl: string | null;
}

function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function FillWithExtensionButton({ jobId, applyUrl }: FillWithExtensionButtonProps) {
  const t = useTranslations('extensionWeb');
  const href = safeHttpUrl(applyUrl);
  const job = useJob(href ? jobId : null);
  const brand = useBrandId();
  const supported = job.data?.autofill?.supported === true && extensionFillsAts(brand, job.data?.autofill?.atsType);
  const presence = useExtensionPresence({ enabled: !!href && supported });

  if (!href || !supported) return null;
  if (presence.state === 'present') {
    return (
      <div className={s.fill}>
        <a className={s.fillAction} href={href} target="_blank" rel="noopener noreferrer" data-ats={job.data?.autofill?.atsType ?? undefined}>
          {t('fill.cta')}
          <span className="sr-only"> {t('fill.newTab')}</span>
        </a>
        <p className={s.meta}>{t('fill.note')}</p>
      </div>
    );
  }
  if (presence.state === 'absent') {
    return (
      <div className={s.fill}>
        <a className={s.fillAction} href="/extension">
          {t('fill.install')}
        </a>
      </div>
    );
  }
  return null;
}

export default FillWithExtensionButton;
