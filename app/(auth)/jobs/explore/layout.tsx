// /jobs/explore — the page's own title (INT-06; wave3 WP-93 #18). It used to
// borrow the retired job-search title, which also printed a fixed product
// name: the title now reads "Explore jobs | <brand>" from `jobs.explore.meta*`
// in the request's brand and language. Signed-in page: never indexed.
//
// Owner: WP-33. The page renders Explore (components/features/feed/Explore.tsx).

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { getBrand } from '../../../../lib/brand/registry.generated';
import { messageAt } from '../../../../lib/seo';
import { getServerBrandId } from '../../../../lib/server/brand';
import { resolveLocale } from '../../../../lib/serverLocale';

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand(await getServerBrandId());
  const locale = await resolveLocale(brand);
  const description = messageAt(locale, brand.id, 'jobs.explore.metaDescription');
  return {
    title: `${messageAt(locale, brand.id, 'jobs.explore.metaTitle', messageAt(locale, brand.id, 'jobs.explore.title', brand.name))} | ${brand.name}`,
    ...(description ? { description } : {}),
    robots: { index: false, follow: false },
  };
}

export default function JobsExploreLayout({ children }: { children: ReactNode }) {
  return children;
}
