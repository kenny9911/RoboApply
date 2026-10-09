// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('pdf-parse/worker', () => {
  throw new Error('Native canvas unavailable');
});

it('keeps the PDF module importable when its native runtime is unavailable', async () => {
  // The API imports PDFService while registering routes. Native PDF failures
  // must be raised by a PDF operation, never while starting the entire API.
  const { parsePdf, renderPdfPages } = await import('./parsePdf.js');
  await expect(parsePdf(Buffer.from('PDF'))).rejects.toThrow();
  await expect(renderPdfPages(Buffer.from('PDF'), 1)).rejects.toThrow();
});
