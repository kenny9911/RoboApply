// server/src/features/jobs/companies/index.ts — public surface (FND-5; owner WP-16b).
// The Assistant's company_insights tool and job detail use `companyService.profile`.

import { NotImplementedError } from '../../../platform/http.js';
import type { CompanyProfile, CompanyTypeaheadItem } from './contract.js';

export * from './contract.js';
export { createCompaniesRouter } from './routes.js';

export interface CompanyService {
  profile(idOrSlug: string): Promise<CompanyProfile>;
  typeahead(q: string, limit?: number): Promise<CompanyTypeaheadItem[]>;
}

export const companyService: CompanyService = {
  async profile() {
    throw new NotImplementedError('companies.profile');
  },
  async typeahead() {
    throw new NotImplementedError('companies.typeahead');
  },
};
