// lib/api/companyFacts.ts — a company's sponsorship facts (JI-11).
//
// Thin typed wrapper over the area contract (FND-7). Owner: MKT-5G.
// The types come from server/src/features/jobs/companies/sponsorship/contract.ts,
// which the companies contract re-exports, so they arrive through the existing
// mirror lib/api/contracts/jobs/companies.
//
// What a fact is: a public record about the EMPLOYER (certified H-1B labor
// condition applications, H-1B petitions approved and denied, a UK sponsor
// licence), with the publication, the file and the date it comes from. It is
// never a statement about a job: the answer's disclaimer says so, and so does
// the block that shows the facts (components/features/job/SponsorshipFacts).
//
// RoboApply only (flag `h1bHistory`): on GoApply the route answers 404
// `feature_disabled`, and callers do not ask.
//
// Endpoints:
//   GET /api/v1/roboapply/companies/:id/sponsorship

import { call, type CallOptions, type In, seg, withQuery } from './contracts/wire';
import type * as CO from './contracts/jobs/companies';

export type {
  CompanySponsorshipResponse,
  DolLcaFact,
  SponsorshipFact,
  SponsorshipFactKind,
  SponsorshipFactSource,
  UkSponsorRegisterFact,
  UscisH1bHubFact,
} from './contracts/jobs/companies';

/** `companies.sponsorship` — GET /api/v1/roboapply/companies/:id/sponsorship */
export function getCompanySponsorship(id: string, query?: In<typeof CO.CompanySponsorshipQuerySchema>, opts?: CallOptions): Promise<CO.CompanySponsorshipResponse> {
  return call<CO.CompanySponsorshipResponse>('GET', withQuery(`/api/v1/roboapply/companies/${seg(id)}/sponsorship`, query), opts);
}

/** React Query key of one company's facts as shown on one job page (the job decides who the block opens for). */
export function companySponsorshipKey(companyId: string, jobId: string | null | undefined): readonly unknown[] {
  return ['companyFacts', 'sponsorship', companyId, jobId ?? ''] as const;
}

/** Every wrapper of this area, for callers that prefer one import. */
export const companyFactsApi = {
  getCompanySponsorship,
};
