// server/src/features/offers/index.ts — public surface (FND-5; owner WP-64).

import { NotImplementedError } from '../../platform/http.js';
import type { OfferView } from './contract.js';

export * from './contract.js';
export { createOffersRouter } from './routes.js';

export interface OffersService {
  list(userId: string): Promise<OfferView[]>;
}

export const offersService: OffersService = {
  async list() {
    throw new NotImplementedError('offers.list');
  },
};
