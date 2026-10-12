// WP-36b — the client layout model mirrors the server export
// (server/src/roboapply/v2/lib/resumeExport.ts): same templates, same date
// rules, same sidebar sections; and the export wrapper in lib/api/resumes.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatDatesIn,
  isSidebarSection,
  layoutPatch,
  normalizeTemplate,
  pageAspect,
  resolveLayout,
  spacingPresetOf,
  SPACING_PRESETS,
  TEMPLATES,
} from './layout';

// Loaded by path so the web type-check does not pull pdfkit's (server-only) types in.
interface ServerLayout {
  RESUME_TEMPLATE_KEYS: readonly string[];
  normalizeTemplate(v: unknown): string;
  formatDatesIn(text: string, format: string): string;
  isSidebarSection(title: string): boolean;
}
const SERVER_EXPORT = '../../../server/src/roboapply/v2/lib/resumeExport';
import { downloadResumeExport, filenameFromDisposition, resumeExportUrl } from '../../../lib/api/resumes';
import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';

describe('layout model', () => {
  it('resolves defaults and the server page default', () => {
    expect(resolveLayout(null, 'a4')).toEqual({
      template: 'standard',
      page: 'a4',
      font: 'sans',
      accent: '#1a1a1a',
      headerAlign: 'left',
      dateFormat: 'as_written',
      spacing: 'normal',
      justify: false,
      bullet: 'solid',
      eduOrder: 'as_written',
      skillsLayout: 'grouped',
      headingLanguage: 'as_written',
      photo: true,
    });
    expect(resolveLayout({ template: 'centered', page: 'letter', spacing: { ...SPACING_PRESETS.tight } }, 'a4')).toMatchObject({
      template: 'centered',
      page: 'letter',
      headerAlign: 'center',
      spacing: 'tight',
    });
    expect(resolveLayout({ accent: 'red' }).accent).toBe('#1a1a1a');
  });

  it('turns a picker change into the PATCH /:id/layout body', () => {
    expect(layoutPatch({ spacing: 'roomy' })).toEqual({ spacing: SPACING_PRESETS.roomy });
    expect(layoutPatch({ template: 'two_column', page: 'a4' })).toEqual({ template: 'two_column', page: 'a4' });
    expect(spacingPresetOf(undefined)).toBe('normal');
    expect(pageAspect('a4')).toBeCloseTo(1.414, 2);
  });

  it('has the same templates, date rules and sidebar sections as the export', async () => {
    const server = (await import(/* @vite-ignore */ SERVER_EXPORT)) as ServerLayout;
    expect([...TEMPLATES]).toEqual([...server.RESUME_TEMPLATE_KEYS]);
    for (const v of ['two-column', 'split', 'ats-clean', 'compact', 42]) {
      expect(normalizeTemplate(v)).toBe(server.normalizeTemplate(v));
    }
    const line = 'Engineer · Sept 2020 – 07/2022; 2023-01 – Present';
    for (const f of ['as_written', 'MM/YYYY', 'Mon YYYY', 'YYYY'] as const) {
      expect(formatDatesIn(line, f)).toBe(server.formatDatesIn(line, f));
    }
    for (const title of ['Skills', 'Experience', '教育经历', 'Projects', 'Languages']) {
      expect(isSidebarSection(title)).toBe(server.isSidebarSection(title));
    }
  });
});

describe('export wrapper (moved from lib/resumeDownload.ts)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the export URL with the preset and the application', () => {
    const url = resumeExportUrl('r 1', { format: 'docx', nameStyle: 'name_role', trackerEntryId: 'tr1' });
    expect(url).toMatch(/\/api\/v1\/roboapply\/v2\/resumes\/r%201\/export\?format=docx&nameStyle=name_role&trackerEntryId=tr1$/);
    expect(resumeExportUrl('r1', { format: 'pdf' })).toMatch(/\/export\?format=pdf$/);
  });

  it('reads CJK file names from filename*', () => {
    expect(filenameFromDisposition(`attachment; filename="___.pdf"; filename*=UTF-8''%E7%8E%8B%E5%B0%8F%E6%98%8E.pdf`, 'x.pdf')).toBe('王小明.pdf');
    expect(filenameFromDisposition(null, 'x.pdf')).toBe('x.pdf');
  });

  it('saves the file and returns the artifact id', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(['%PDF']), {
        status: 200,
        headers: { 'Content-Disposition': `attachment; filename="a.pdf"; filename*=UTF-8''Ada%20-%20Acme.pdf`, 'X-Artifact-Id': 'art1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const result = await downloadResumeExport('r1', { format: 'pdf', trackerEntryId: 'tr1' }, 'Main');
    expect(result).toEqual({ fileName: 'Ada - Acme.pdf', artifactId: 'art1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('trackerEntryId=tr1');
    expect(init.credentials).toBe('include');
    expect(create).toHaveBeenCalled();
  });

  it('rejects with the server code and details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unverified_claims', code: 'unverified_claims', details: { count: 2 } }), { status: 409 })),
    );
    const err = await downloadResumeExport('r1', { format: 'pdf' }, 'Main').catch((e: unknown) => e);
    expect(apiErrorCode(err)).toBe('unverified_claims');
    expect(apiErrorDetails<{ count: number }>(err)?.count).toBe(2);
  });
});
