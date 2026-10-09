'use client';

// OfferSection — the offer block in an application's detail drawer: the
// user's own offer numbers (base, bonus, equity; GoApply 月薪·N薪, 年终,
// 五险一金, 公积金, 户口, 签字费, 期权) (TASK_PLAN.md WP-64).
//
// STUB (FND-6b). Owner: WP-64. Renders nothing. WP-38's tracker drawer
// renders it for every entry; it shows itself only when the `offers` flag is
// on. Writes go through `tracker.updateOffer()` / lib/api/offers.ts.

export interface OfferSectionProps {
  /** RATrackerEntry id of the application. */
  trackerEntryId: string;
  /** Called after the offer was saved, so the drawer can refresh. */
  onChange?: () => void;
}

export function OfferSection(_props: OfferSectionProps): null {
  return null;
}

export default OfferSection;
