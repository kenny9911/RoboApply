// extension/src/brands/types.ts — what one brand build of the extension needs.

import type { BrandId, Market, RoboLocale } from '../../../server/src/platform/brand/registry';

export type { BrandId, Market, RoboLocale };

export interface ExtBrandValues {
  /** Which adapter set the build ships (`adapters/intl` or `adapters/cn`). */
  adapterSet: 'intl' | 'cn';
  /**
   * Origins of the brand's web app that may message the extension in a dev
   * build (`externally_connectable`, pairing). Production builds use the
   * registry's production hosts only.
   */
  devWebOrigins: string[];
  /** API origin a dev build talks to when `--api-origin` is not given. */
  devApiOrigin: string;
}

export interface ExtBrandConfig extends ExtBrandValues {
  id: BrandId;
  market: Market;
  /** Product name from the registry; substitutes %BRAND% in strings. */
  name: string;
  otherBrandName: string;
  defaultLocale: RoboLocale;
  /** Production web hosts (registry `hosts`). */
  webHosts: string[];
  /** Registry dev hosts (pairing is accepted from them only in dev builds). */
  devHosts: string[];
  /** Production API origin: the canonical web origin (same-origin `/api/*`). */
  apiOrigin: string;
}
