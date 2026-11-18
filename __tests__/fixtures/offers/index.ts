// __tests__/fixtures/offers — a user-entered offer (fictional data).
import type { RequestFixture } from '../types';

export const offerBody = { base: 120000, currency: 'USD', period: 'year' } as const;

export const offersRequests: RequestFixture[] = [
  { contract: 'offers', schema: 'PutOfferBodySchema', value: offerBody },
  { contract: 'offers', schema: 'PutOfferBodySchema', value: { ...offerBody, currency: 'usd' }, valid: false },
  { contract: 'offers', schema: 'CompareOffersBodySchema', value: { trackerEntryIds: ['a', 'b'] } },
  // REQ-64-06 (Wave 5 gate): the same offer twice is not a comparison.
  { contract: 'offers', schema: 'CompareOffersBodySchema', value: { trackerEntryIds: ['a', 'a'] }, valid: false },
];
