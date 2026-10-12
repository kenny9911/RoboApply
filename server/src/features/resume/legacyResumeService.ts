// server/src/features/resume/legacyResumeService.ts
//
// A narrow, typed handle on the legacy V2 resume service (RAResumeService) for
// the RES area's WP-65 routes: create a base resume, patch its hub fields,
// read its hub view, delete it. Loaded by path at call time, so the web type-check (which
// reads server/src/features through the contract mirrors) never pulls the
// upload / parse stack and its untyped modules in. The legacy router imports
// the same module statically, so it is always part of the server build.

export interface LegacyResumeService {
  create(
    userId: string,
    body: { kind: 'base'; name: string; resumeMarkdown: string },
    locale?: string,
  ): Promise<{ id: string }>;
  patch(userId: string, id: string, body: { targetTitle?: string | null; aiAssisted?: boolean }): Promise<unknown>;
  getById(userId: string, id: string): Promise<Record<string, unknown>>;
  delete(userId: string, id: string): Promise<void>;
}

export interface LegacyResumeModule {
  raResumeService: LegacyResumeService;
  ResumeLimitError: new (...args: never[]) => Error;
  BASE_RESUME_LIMIT: number;
}

const MODULE_PATH = '../../roboapply/v2/services/RAResumeService.js';

export async function loadLegacyResumeModule(): Promise<LegacyResumeModule> {
  return (await import(/* @vite-ignore */ MODULE_PATH)) as LegacyResumeModule;
}
