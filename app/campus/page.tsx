// /campus — GoApply 校招日历 (WP-58; F-TOOL-05 cn, F-SEO-07 cn; flag `jobs.campusCalendar`, R-14).
//
// Public page in HybridShell (R-23): the app shell with a session, marketing
// chrome and the legal footer without one. The first page of programmes is
// rendered on the server from the public API (crawlers see every entry with
// its official link and last check). Capability off ⇒ the API answers 404
// feature_disabled and so does this page (R-04). Filters live in the URL.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { HybridShell } from '../../components/v3/shell/HybridShell';
import { LegalFooter } from '../../components/features/market';
import { CampusCalendar } from '../../components/features/campus';
import { campusListQuery, campusMetadata, campusSearch, readCampusList } from '../../components/features/campus/serverData';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const filter = campusSearch(await searchParams);
  const read = await readCampusList(campusListQuery(filter));
  // Only the unfiltered calendar is indexed; filtered views are for people.
  const indexable = read.status === 'ok' && campusListQuery(filter) === '';
  return campusMetadata({ path: '/campus', titleKey: 'campus.meta.title', descriptionKey: 'campus.meta.description', indexable });
}

export default async function CampusPage({ searchParams }: { searchParams: SearchParams }) {
  const filter = campusSearch(await searchParams);
  const read = await readCampusList(campusListQuery(filter));
  if (read.status === 'disabled') notFound();
  return (
    <HybridShell from="campus" footer={<LegalFooter />}>
      <CampusCalendar initial={read.status === 'ok' ? read.data : null} filter={filter} />
    </HybridShell>
  );
}
