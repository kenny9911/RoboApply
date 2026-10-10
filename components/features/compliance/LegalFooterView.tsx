'use client';

// LegalFooterView — renders a LegalFooterModel (server/src/features/compliance
// contract). Every line is optional: a value that is not configured is left
// out, never shown empty or as "pending" (D3; CN plan §5.3). The filing-status
// note appears only verbatim from CN_GENAI_STATUS_NOTE.
//
// Two controls sit with the document links (WP-93):
//   - "Privacy choices" shows the analytics question again
//     (`requestAnalyticsConsentReview()`), so a visitor can change an answer
//     they gave. It appears only for a visitor who has answered — where the
//     question is never asked (GoApply; regions where we need not ask) there
//     is nothing to review, and a button that does nothing is not shown.
//   - "Cancel a subscription" (`CancelFooterLink`, §312k BGB) on every
//     RoboApply page. The marketing chrome prints it in its own footer
//     column; when this footer finds that link on the page it drops its own
//     copy, so the link is always there once, never twice. The mainland
//     market (GoApply) sells passes that do not renew, so there is no
//     subscription to cancel and this footer does not add the link there.

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { readAnalyticsConsent, requestAnalyticsConsentReview } from '../../../lib/analytics';
import type { LegalFooterModel } from '../../../lib/api/contracts/compliance';
import { cn } from '../../../lib/utils';
import { CancelFooterLink } from '../credits';
import styles from './compliance.module.css';

export interface LegalFooterViewProps {
  model: LegalFooterModel;
  variant?: 'marketing' | 'app';
  /** Extra document links (e.g. the Taiwan notice for zh-TW readers). */
  extraDocs?: string[];
  /** For the © line; defaults to the current year. */
  year?: number;
  /**
   * "Privacy choices": 'auto' (default) shows it once the visitor has answered
   * the analytics question on this device; true always; false never.
   */
  privacyChoices?: boolean | 'auto';
  /**
   * "Cancel a subscription": 'auto' (default) shows it unless the page already
   * has that link outside this footer, and never on the mainland market
   * (no renewing plans there); true always; false never.
   */
  cancelLink?: boolean | 'auto';
}

const CANCEL_LINK_SELECTOR = '[data-testid="cancel-footer-link"]';

export function LegalFooterView({
  model,
  variant = 'marketing',
  extraDocs = [],
  year = new Date().getFullYear(),
  privacyChoices = 'auto',
  cancelLink = 'auto',
}: LegalFooterViewProps) {
  const t = useTranslations('legal');
  const footerRef = useRef<HTMLElement>(null);
  const [answered, setAnswered] = useState(false);
  const [cancelElsewhere, setCancelElsewhere] = useState(false);

  // The analytics answer lives in a cookie: read it after mount (never during
  // server render) and again after any click, since the banner's own buttons
  // are how it changes.
  useEffect(() => {
    if (privacyChoices !== 'auto') return undefined;
    const check = () => setAnswered(readAnalyticsConsent() !== null);
    check();
    const onClick = () => setTimeout(check, 0);
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [privacyChoices]);

  const autoCancel = cancelLink === 'auto' && model.market !== 'cn';
  useEffect(() => {
    if (!autoCancel) return;
    const own = footerRef.current;
    const others = Array.from(document.querySelectorAll(CANCEL_LINK_SELECTOR)).filter((el) => !own?.contains(el));
    setCancelElsewhere(others.length > 0);
  }, [autoCancel]);

  const showPrivacyChoices = privacyChoices === 'auto' ? answered : privacyChoices;
  const showCancel = cancelLink === 'auto' ? autoCancel && !cancelElsewhere : cancelLink;
  const links = [...model.links, ...extraDocs.filter((d) => !model.links.some((l) => l.doc === d)).map((doc) => ({ doc, href: `/legal/${doc}` }))];
  const lines: Array<{ key: string; node: ReactNode }> = [];

  if (model.entity) lines.push({ key: 'entity', node: t('footer.copyright', { year, entity: model.entity }) });
  if (model.icp) {
    lines.push({
      key: 'icp',
      node: (
        <a href={model.icp.url} target="_blank" rel="noopener noreferrer">
          {t('footer.icp', { number: model.icp.number })}
        </a>
      ),
    });
  }
  if (model.psb) {
    const label = t('footer.psb', { number: model.psb.number });
    lines.push({
      key: 'psb',
      node: model.psb.url ? (
        <a href={model.psb.url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      ),
    });
  }
  if (model.edi) lines.push({ key: 'edi', node: t('footer.edi', { number: model.edi }) });
  if (model.hrLicence) lines.push({ key: 'hr', node: t('footer.hrLicence', { number: model.hrLicence.number, holder: model.hrLicence.holder }) });
  if (model.aiModels.length > 0) {
    const models = model.aiModels
      .map((m) => (m.filingNo ? t('footer.modelWithFiling', { model: m.model, filingNo: m.filingNo }) : m.model))
      .join(', ');
    lines.push({ key: 'models', node: t('footer.aiModels', { models }) });
  }
  if (model.genaiRegistration) lines.push({ key: 'genai', node: t('footer.genaiRegistration', { number: model.genaiRegistration }) });
  if (model.algorithmFiling) lines.push({ key: 'algo', node: t('footer.algorithmFiling', { number: model.algorithmFiling }) });
  if (model.statusNote) lines.push({ key: 'note', node: t('disclosures.statusNote', { note: model.statusNote }) });
  if (model.complaints?.email) {
    lines.push({
      key: 'complaintsEmail',
      node: <a href={`mailto:${model.complaints.email}`}>{t('footer.complaintsEmail', { email: model.complaints.email })}</a>,
    });
  }
  if (model.complaints?.phone) lines.push({ key: 'complaintsPhone', node: t('footer.complaintsPhone', { phone: model.complaints.phone }) });

  return (
    <footer ref={footerRef} className={cn(styles.footer, variant === 'app' && styles.footerApp)} data-testid="legal-footer" data-market={model.market}>
      <div className={styles.footerInner}>
        <nav aria-label={t('footer.aria')}>
          <ul className={styles.footerLinks}>
            {links.map((l) => (
              <li key={l.doc}>
                <Link href={l.href}>{t(`docs.${l.doc}`)}</Link>
              </li>
            ))}
            {showPrivacyChoices ? (
              <li>
                <button type="button" className={styles.footerButton} data-testid="privacy-choices" onClick={() => requestAnalyticsConsentReview()}>
                  {t('footer.privacyChoices')}
                </button>
              </li>
            ) : null}
            {showCancel ? (
              <li>
                <CancelFooterLink />
              </li>
            ) : null}
          </ul>
        </nav>
        {lines.length > 0 ? (
          <ul className={styles.footerLines}>
            {lines.map((l) => (
              <li key={l.key} className={styles.footerLine} data-line={l.key}>
                {l.node}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </footer>
  );
}

export default LegalFooterView;
