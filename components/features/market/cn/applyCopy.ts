// components/features/market/cn/applyCopy.ts — where the apply button leads
// on GoApply (D1, D3; MARKET_STRATEGY M-7). The button opens the posting's own
// apply link in a new tab and says where that is: the employer's careers site
// for a posting read from an employer's board, the recruiter bank's page for a
// bank row. Nothing is submitted for the user. Pure: callers pass the keys to
// `t()` of the `jobsCn` namespace.

import type { ListingApply, ListingSource } from '../../../../lib/api/feed';

export interface CnApplyCopy {
  /** Key under `jobsCn.apply`, with `{name}` for the bank's own name. */
  labelKey: 'apply.employer' | 'apply.bank';
  hintKey: 'apply.employerHint' | 'apply.bankHint';
  /** The recruiter bank's name for the bank keys (e.g. GoHire). */
  name: string;
}

/**
 * The GoApply apply-button copy for a listing, or null when the target is not
 * known (the shared wording is used then: nothing is guessed from the link).
 */
export function cnApplyCopy(listing: { source: ListingSource; apply: ListingApply }): CnApplyCopy | null {
  if (listing.apply.target === 'employer') return { labelKey: 'apply.employer', hintKey: 'apply.employerHint', name: '' };
  const bank = listing.source.name ?? listing.source.original;
  if (listing.apply.target === 'gohire' && bank) return { labelKey: 'apply.bank', hintKey: 'apply.bankHint', name: bank };
  return null;
}
