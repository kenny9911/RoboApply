'use client';

// OfferComparison — side-by-side offers with deterministic totals and stated
// assumptions (TASK_PLAN.md WP-64; ruling C9).
//
// STUB (FND-6b). Owner: WP-64. Renders nothing. WP-38's Applications page
// mounts it as the "Offers" view when the `offers` flag is on. With no ids it
// compares every application that has an offer; market benchmarks only
// through `Sourced` values with N shown (D3).

export interface OfferComparisonProps {
  /** RATrackerEntry ids to compare (2–5); omitted = every entry with an offer. */
  trackerEntryIds?: readonly string[];
}

export function OfferComparison(_props: OfferComparisonProps = {}): null {
  return null;
}

export default OfferComparison;
