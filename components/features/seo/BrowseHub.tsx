'use client';

// BrowseHub — `/browse`: the indexable job lists (from `seo-rebuild`), most
// jobs first, each with its real count. Also the fallback list under an
// unknown role (`BrowseUnknown`).

import Link from 'next/link';

import type { SeoLink } from '../../../lib/api/contracts/seo';
import type { BrowseUnknownQuery } from '../../../lib/seo';
import { SourceNote } from '../common';
import { cityLabel, countryLabel, roleLabel, useSeoFormat } from './labels';
import styles from './seo.module.css';

export function useBrowseLinkTitle() {
  const { t, locale } = useSeoFormat();
  return (link: SeoLink): string => {
    const role = roleLabel(link.role, locale);
    switch (link.kind) {
      case 'city':
        return t('browse.title.role_city', { role, city: cityLabel(link.city, locale) });
      case 'remote':
        return t('browse.title.remote_role', { role });
      case 'graduate':
        return t('browse.title.graduate_role', { role });
      case 'sponsorship':
        return t('browse.title.sponsorship_role', { role, country: countryLabel(link.country, locale) });
      case 'segment':
        return link.segment === 'internships' ? t('browse.title.segment_internships') : t('browse.title.segment_entry');
      case 'hub':
        return t('browse.up.hub');
      default:
        return t('browse.title.role', { role });
    }
  };
}

/** The newest count among the links: its source line covers every chip count (all are index counts, D3). */
export function newestCount(links: readonly SeoLink[]): SeoLink['jobCount'] {
  let best: SeoLink['jobCount'] = null;
  for (const l of links) if (l.jobCount && (!best || l.jobCount.asOf > best.asOf)) best = l.jobCount;
  return best;
}

export function BrowseLinkList({ links }: { links: readonly SeoLink[] }) {
  const { t } = useSeoFormat();
  const title = useBrowseLinkTitle();
  if (!links.length) return <p className={styles.note}>{t('browse.hub.empty')}</p>;
  const counted = newestCount(links);
  return (
    <>
      <ul className={styles.chips}>
        {links.map((l) => (
          <li key={l.path}>
            <Link className={styles.chip} href={l.path}>
              {title(l)}
              {l.jobCount ? <span className={styles.chipCount}>{t('browse.children.count', { count: l.jobCount.value })}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
      {counted ? <SourceNote sourced={counted} className={styles.sourceNote} /> : null}
    </>
  );
}

export function BrowseHub({ links }: { links: readonly SeoLink[] }) {
  const { t } = useSeoFormat();
  return (
    <div className={styles.page} data-seo-page="hub">
      <header className={styles.intro}>
        <h1 className={styles.h1}>{t('browse.hub.title')}</h1>
        <p className={styles.lede}>{t('browse.hub.sub')}</p>
      </header>
      <section className={styles.section}>
        <BrowseLinkList links={links} />
      </section>
    </div>
  );
}

/** A browse path whose role (or city) we cannot resolve: not indexed, names what we could not find, points at real lists. */
export function BrowseUnknown({ query, links }: { query: BrowseUnknownQuery; links: readonly SeoLink[] }) {
  const { t } = useSeoFormat();
  const isCity = query.kind === 'city' && !!query.city;
  return (
    <div className={styles.page} data-seo-page="unknown" data-unknown={isCity ? 'city' : 'role'}>
      <header className={styles.intro}>
        <h1 className={styles.h1}>{isCity ? t('browse.unknownCity.title', { role: query.role, city: query.city! }) : t('browse.unknown.title', { role: query.role })}</h1>
        <p className={styles.lede}>{isCity ? t('browse.unknownCity.body') : t('browse.unknown.body')}</p>
      </header>
      <section className={styles.section}>
        <BrowseLinkList links={links} />
      </section>
    </div>
  );
}
