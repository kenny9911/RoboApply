// components/features/seo/server.ts — SERVER-ONLY pieces of the SEO area.
//
//   import { JobTicker } from '../components/features/seo/server';
//   <JobTicker />   // in a server route file (e.g. the RoboApply home, WP-40 / INT)

export { JobTicker } from './JobTicker';
export { browseJsonLd, browseMetadata, jobJsonLd, jobMetadata, seoRequest, seoTranslator } from './serverMeta';
