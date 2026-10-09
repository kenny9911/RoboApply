// server/src/features/jobs/import/index.ts — public surface (FND-5; owner WP-35).
// The Assistant's add_external_job proposal applies through `importJob`.

import { NotImplementedError } from '../../../platform/http.js';
import type { ImportJobBody, ImportJobResponse } from './contract.js';

export * from './contract.js';
export { createJobImportRouter } from './routes.js';

export interface JobImportService {
  importJob(userId: string, body: ImportJobBody, idempotencyKey: string): Promise<ImportJobResponse>;
}

export const jobImportService: JobImportService = {
  async importJob() {
    throw new NotImplementedError('jobImport.importJob');
  },
};
