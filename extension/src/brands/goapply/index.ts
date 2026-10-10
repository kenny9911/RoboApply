// extension/src/brands/goapply/index.ts — GoApply build values (mainland China, 一键填表).
//
// Names, hosts and the API origin come from the brand registry (brands/index.ts);
// the form hosts come from adapters/cn (Moka, Beisen, Feishu, Dayee) through
// src/manifest.ts. This file holds what only the GoApply build needs:
//   - the adapter set and dev origins (ExtBrandValues);
//   - distribution: Microsoft Edge Add-ons first (reachable in the mainland),
//     the Chrome Web Store second, and a self-hosted signed CRX with an update
//     manifest for browsers that accept a manual install (360 / QQ, best effort).
//     Publishing steps: docs/runbooks/edge-addons-publish.md.
//   - the manifest strings: `extension-cn.manifest.*` (i18n/staging/extension-cn.{en,zh}.json).
// Strings never name the product: %BRAND% is substituted from the registry.
//
// GOAPPLY_DISTRIBUTION and the `extension-cn.manifest.*` strings are not read
// by scripts/build.mjs yet (owned by INT): until INT wires them, the GoApply
// build keeps the registry's store name and English `_locales`. The tests in
// test/cn/manifest.test.ts check them against buildManifest() meanwhile.

import { CN_PORTAL_ADAPTERS } from '../../adapters/cn/index';
import type { ExtBrandValues } from '../types';

export const GOAPPLY_EXT: ExtBrandValues = {
  adapterSet: 'cn',
  devWebOrigins: ['http://goapply.localhost:3611'],
  devApiOrigin: 'http://goapply.localhost:3611',
};

export type StoreId = 'edge' | 'chrome' | 'crx';

export interface GoApplyDistribution {
  /** Store order: Edge Add-ons is primary (CN_TW_LAUNCH_PLAN §3; ARCHITECTURE §6.8). */
  stores: readonly StoreId[];
  /** The build each store receives (`scripts/build.mjs --brand=goapply --target=…`). */
  buildTarget: Record<StoreId, 'edge' | 'chrome'>;
  /** Paths on the brand's own web origin for the self-hosted CRX channel. */
  crxPath: string;
  updateManifestPath: string;
  /** Store privacy fields (D1: the form is read only after the user's click). */
  privacy: { dataUse: string; websiteContent: 'user-initiated only'; sold: false };
  /** The manifest strings of this build (namespace `extension-cn`). */
  manifestStringsKey: 'extension-cn.manifest';
}

export const GOAPPLY_DISTRIBUTION: GoApplyDistribution = {
  stores: ['edge', 'chrome', 'crx'],
  buildTarget: { edge: 'edge', chrome: 'chrome', crx: 'chrome' },
  crxPath: '/extension/goapply.crx',
  updateManifestPath: '/extension/goapply-updates.xml',
  privacy: {
    dataUse: 'Personal info and website content, sent only to the brand API to fill the form the user opened.',
    websiteContent: 'user-initiated only',
    sold: false,
  },
  manifestStringsKey: 'extension-cn.manifest',
};

/** Ids of the portal adapters the GoApply build ships (for the server's supported list and the store listing). */
export function goapplyPortalIds(): string[] {
  return CN_PORTAL_ADAPTERS.map((a) => a.id);
}
