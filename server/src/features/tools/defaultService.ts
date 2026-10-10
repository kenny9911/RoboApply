// server/src/features/tools/defaultService.ts — production wiring of the
// free tools service (WP-57). Heavy modules load on first use only.

import { getCurrentBrand } from '../../platform/brand/brandContext.js';
import { runChecklist, runRequirementRows } from './checks.js';
import { defaultParseUpload } from './parse.js';
import { ResumeLimitReachedError, createToolsRate, createToolsService, type ToolsService } from './service.js';
import { createPrismaRateCounterReader, createPrismaToolsStore } from './store.js';

/**
 * RAResumeService is loaded by a computed specifier: the web typecheck reaches
 * this file through the feature mount table, and that service pulls modules
 * only the server build accepts (untyped document parsers).
 */
const RESUME_SERVICE = '../../roboapply/v2/services/RAResumeService.js';

interface ResumeServiceModule {
  raResumeService: { create(userId: string, body: { kind: 'base'; name: string; resumeMarkdown: string }): Promise<{ id: string }> };
  ResumeLimitError: new (...args: never[]) => Error;
}

/** Keep the checked resume as a base resume in the account; a full list → ResumeLimitReachedError. */
export async function keepResumeInAccount(userId: string, input: { name: string; markdown: string }): Promise<{ id: string }> {
  const { raResumeService, ResumeLimitError } = (await import(RESUME_SERVICE)) as ResumeServiceModule;
  try {
    const view = await raResumeService.create(userId, { kind: 'base', name: input.name, resumeMarkdown: input.markdown });
    return { id: view.id };
  } catch (err) {
    if (err instanceof ResumeLimitError) throw new ResumeLimitReachedError(err.message);
    throw err;
  }
}

let singleton: ToolsService | null = null;

/** The process-wide tools service (Prisma store, platform limiter, the brand's parser path). */
export function getToolsService(): ToolsService {
  singleton ??= createToolsService({
    store: createPrismaToolsStore(),
    rate: createToolsRate({ reader: createPrismaRateCounterReader() }),
    parse: defaultParseUpload,
    checklist: (markdown, profile) => runChecklist(markdown, profile),
    requirementRows: (markdown, posting, profile) => runRequirementRows(markdown, posting, profile),
    createResume: keepResumeInAccount,
    brand: getCurrentBrand,
  });
  return singleton;
}
