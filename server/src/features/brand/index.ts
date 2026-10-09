// server/src/features/brand/index.ts — public surface of the brand area.
// Mount path: /api/v1/public/brand (mounted in server/src/app.ts by FND-2a).

export { default as brandPublicRouter, buildPublicBrand, createBrandPublicRouter } from './routes.js';
export type { PublicBrand, PublicBrandResponse } from './contract.js';
export { PublicBrandSchema, PUBLIC_BRAND_MAX_AGE_SEC } from './contract.js';
