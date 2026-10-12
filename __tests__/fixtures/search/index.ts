// __tests__/fixtures/search — a search profile (fictional data).
import type * as S from '../../../lib/api/contracts/search';
import type { RequestFixture } from '../types';

export const searchProfileRequests: RequestFixture[] = [
  { contract: 'search', schema: 'CreateSearchProfileBodySchema', value: { name: '', filters: {}, activate: true } },
  { contract: 'search', schema: 'CreateSearchProfileBodySchema', value: { name: '', filters: {}, colour: 'red' }, valid: false },
];

export type SearchProfileList = S.SearchProfileListWire;
