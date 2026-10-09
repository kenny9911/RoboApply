'use client';

// LegalFooterView — renders a LegalFooterModel (server/src/features/compliance
// contract). Every line is optional: a value that is not configured is left
// out, never shown empty or as "pending" (D3; CN plan §5.3). The filing-status
// note appears only verbatim from CN_GENAI_STATUS_NOTE.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import type { LegalFooterModel } from '../../../lib/api/contracts/compliance';
import { cn } from '../../../lib/utils';
import styles from './compliance.module.css';

export interface LegalFooterViewProps {
  model: LegalFooterModel;
  variant?: 'marketing' | 'app';
  /** Extra document links (e.g. the Taiwan notice for zh-TW readers). */
  extraDocs?: string[];
  /** For the © line; defaults to the current year. */
  year?: number;
}

export function LegalFooterView({ model, variant = 'marketing', extraDocs = [], year = new Date().getFullYear() }: LegalFooterViewProps) {
  const t = useTranslations('legal');
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
    <footer className={cn(styles.footer, variant === 'app' && styles.footerApp)} data-testid="legal-footer" data-market={model.market}>
      <div className={styles.footerInner}>
        <nav aria-label={t('footer.aria')}>
          <ul className={styles.footerLinks}>
            {links.map((l) => (
              <li key={l.doc}>
                <Link href={l.href}>{t(`docs.${l.doc}`)}</Link>
              </li>
            ))}
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
