// server/src/features/compliance/index.ts — public surface (FND-5; owner WP-13).

import { NotImplementedError } from '../../platform/http.js';
import type { ImplicitAiLabel } from './contract.js';

export * from './contract.js';
export { createComplianceAdminRouter, createComplianceRouter, createLegalPublicRouter } from './routes.js';
export { COMPLIANCE_WORK_KINDS } from './workers.js';

export interface ComplianceService {
  /** Machine-readable AI label for an exported artifact (WP-36b/37 call it). */
  implicitLabelMetadata(artifact: { contentId: string; provider: string; generatedAt?: Date }): ImplicitAiLabel;
  /** Explicit footer line for a locale (GoApply exports when enabled). */
  explicitFooterLine(locale: string): string;
  /** Writes `RAAiContentLabelLog` (GoApply). */
  logAiContentLabel(input: { userId: string | null; contentId: string; kind: string; provider: string }): Promise<void>;
}

/** Stub until WP-13. */
export const complianceService: ComplianceService = {
  implicitLabelMetadata() {
    throw new NotImplementedError('compliance.implicitLabelMetadata');
  },
  explicitFooterLine() {
    throw new NotImplementedError('compliance.explicitFooterLine');
  },
  async logAiContentLabel() {
    throw new NotImplementedError('compliance.logAiContentLabel');
  },
};
