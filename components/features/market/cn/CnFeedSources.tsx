'use client';

// CnFeedSources — the line under the GoApply jobs header that says where the
// postings in the list come from (D3; MARKET_STRATEGY §1.4):
//   来自 N 家企业招聘官网
//   来自 GoHire 与 N 家企业招聘官网   (only when GoHire rows are listed)
// built only from the feed response's own `sources`, followed by a sentence
// that this is what has been collected, not the whole market. Renders nothing
// on RoboApply, and nothing when the response names no source.

import { useTranslations } from 'next-intl';

import { useBrand } from '../../../../lib/brand/BrandProvider';
import type { CnFeedHeader } from '../../../../lib/api/cnJobs';
import styles from './cnJobs.module.css';

/** GoApply's recruiter bank, as its rows name it (the registry's `bank_gohire` source). */
export const CN_RECRUITER_BANK_NAME = 'GoHire';

export interface CnFeedSourcesProps {
  header: CnFeedHeader | null;
  /** The recruiter bank's name as the listed rows carry it (default: GoApply's bank). */
  bankName?: string | null;
  className?: string;
}

export function CnFeedSources({ header, bankName, className }: CnFeedSourcesProps) {
  const brand = useBrand();
  const t = useTranslations('jobsCn.header');
  if (brand.market !== 'cn' || !header) return null;
  const sourceName = bankName?.trim() || CN_RECRUITER_BANK_NAME;
  const lead =
    header.kind === 'gohire'
      ? t('gohire', { sourceName })
      : header.kind === 'boards'
        ? t('boards', { count: header.boards })
        : t('gohireAndBoards', { sourceName, count: header.boards });
  return (
    <p className={[styles.sources, className].filter(Boolean).join(' ')} data-testid="cn-feed-sources" data-kind={header.kind}>
      <span className={styles.sourcesLead}>{lead}</span> {t('coverage')}
    </p>
  );
}

export default CnFeedSources;
