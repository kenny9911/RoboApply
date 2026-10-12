// server/src/features/resume/layout/LayoutService.ts
//
// Resume layout: save (PATCH /:id/layout, WP-36b behaviour + WP-65 keys) and
// fit to one page (POST /:id/fit-to-page, WP-65). Never changes resume text.

import { HttpError } from '../../../platform/http.js';
import { resolveLayout, type PageSize, type RenderOptions } from '../../../roboapply/v2/lib/resumeExport.js';
import type { FitRestore, FitSizes, FitSpacing, FitToPageResponse } from '../contract.js';
import { fitToPage } from './fitToPage.js';
import { mergeLayout } from './merge.js';
import type { LayoutStore } from './store.js';

export interface LayoutServiceDeps {
  store: LayoutStore;
  /** PDF pages of `markdown` rendered with `options` (resumeExport.countResumePages). */
  countPages(markdown: string, options: RenderOptions): Promise<number>;
  /** 'cn' on GoApply (resumes may fill 2 pages). */
  market(): 'intl' | 'cn';
}

const SIZE_KEYS = ['name', 'section', 'sub', 'body'] as const;
const SPACING_KEYS = ['section', 'entry', 'line', 'marginX', 'marginY'] as const;

/** A valid 1×1 PNG: stands in for the device photo so the page count reserves its box. */
const PHOTO_PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The stored values for each key (null when none is stored), for an exact Undo. */
function storedValues<K extends string>(raw: unknown, keys: readonly K[]): { [P in K]: number | null } {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as { [P in K]: number | null };
  for (const k of keys) {
    const v = obj[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  return out;
}

export class LayoutService {
  constructor(private readonly deps: LayoutServiceDeps) {}

  /** Merge a layout patch into the stored layout; returns what is now stored. */
  async patch(userId: string, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = await this.deps.store.find(userId, id);
    if (!row) throw new HttpError('not_found', 'Resume not found.');
    const merged = mergeLayout(row.layout, patch);
    if (!(await this.deps.store.save(userId, id, merged))) throw new HttpError('not_found', 'Resume not found.');
    return merged;
  }

  /**
   * Fit the resume on `pages` pages by adjusting spacing, margins and type
   * sizes. Saves explicit values only when they changed something; PATCHing
   * the response's `restore` values back undoes it exactly.
   */
  async fit(
    userId: string,
    id: string,
    input: { pages: 1 | 2; defaultPage: PageSize; locale?: string | null; photo?: boolean },
  ): Promise<FitToPageResponse> {
    const row = await this.deps.store.find(userId, id);
    if (!row) throw new HttpError('not_found', 'Resume not found.');
    const target: 1 | 2 = input.pages === 2 && this.deps.market() === 'cn' ? 2 : 1;
    const stored = row.layout && typeof row.layout === 'object' ? (row.layout as Record<string, unknown>) : {};
    const resolved = resolveLayout(stored, { page: input.defaultPage });
    const markdown = row.resumeMarkdown;
    const restore: { sizes: FitRestore<FitSizes>; spacing: FitRestore<FitSpacing> } = {
      sizes: storedValues(stored.sizes, SIZE_KEYS),
      spacing: storedValues(stored.spacing, SPACING_KEYS),
    };
    // A placed device photo pushes the header down: count pages with its box reserved.
    const photo = input.photo ? PHOTO_PLACEHOLDER : null;
    const result = await fitToPage({
      current: { sizes: resolved.sizes, spacing: resolved.spacing },
      target,
      countPages: (values) =>
        this.deps.countPages(markdown, {
          layout: { ...stored, sizes: values.sizes, spacing: values.spacing },
          defaultPage: input.defaultPage,
          locale: input.locale,
          photo,
        }),
    });
    if (result.applied) {
      const merged = mergeLayout(stored, { sizes: result.applied.sizes, spacing: result.applied.spacing });
      if (!(await this.deps.store.save(userId, id, merged))) throw new HttpError('not_found', 'Resume not found.');
    }
    return { ...result, restore };
  }
}
