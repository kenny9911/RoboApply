'use client';

// PeoplePanel — the People tab's contact list on a job: the user's own
// imported connections at this company and recruiters who opted in to being
// contactable (PRODUCT_PLAN.md §5.11 F-NET; TASK_PLAN.md WP-54).
//
// STUB (FND-6b). Owner: WP-54. Renders nothing. WP-34 renders it inside the
// job's People tab, under the three LinkedIn search deep links it owns, only
// when `hiringContacts` is not 'off'. Every person shown must be a real
// record with its source named (D3); nothing is shown when there is no one.

export interface PeoplePanelProps {
  jobId: string;
  /** RACompany id when the job is linked to one. */
  companyId: string | null;
  /** The company name as the job shows it (for matching and empty states). */
  companyName: string;
}

export function PeoplePanel(_props: PeoplePanelProps): null {
  return null;
}

export default PeoplePanel;
