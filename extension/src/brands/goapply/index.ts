// extension/src/brands/goapply/index.ts — GoApply build values (mainland China).
//
// Seam created by WP-55b; WP-71 owns this folder (manifest values, zh strings
// for 一键填表, Edge Add-ons). Until WP-71 lands, a GoApply build ships the
// core panel with no portal adapters (adapters/cn is empty), so it fills
// nothing and asks for site requests instead.

import type { ExtBrandValues } from '../types';

export const GOAPPLY_EXT: ExtBrandValues = {
  adapterSet: 'cn',
  devWebOrigins: ['http://goapply.localhost:3611'],
  devApiOrigin: 'http://goapply.localhost:3611',
};
