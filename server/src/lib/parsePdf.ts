import type { PDFParse } from 'pdf-parse';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

const require = createRequire(import.meta.url);

async function createParser(buffer: Buffer): Promise<PDFParse> {
  // Load the Node canvas/worker entry first: PDF.js's dynamic native require
  // is otherwise missed by Vercel's file tracer, crashing with missing DOMMatrix.
  // Keep PDF initialization off the API boot path so a parser failure cannot
  // take down unrelated endpoints (including login and /auth/me).
  const { CanvasFactory } = await import('pdf-parse/worker');
  const { PDFParse, VerbosityLevel } = await import('pdf-parse');
  const pdfjsDirectory = dirname(createRequire(require.resolve('pdf-parse')).resolve('pdfjs-dist/package.json'));
  // PDF.js can transfer its input. Copy it so OCR retries retain the original PDF.
  return new PDFParse({
    data: new Uint8Array(buffer),
    CanvasFactory,
    verbosity: VerbosityLevel.ERRORS,
    standardFontDataUrl: join(pdfjsDirectory, `standard_fonts${sep}`),
    cMapUrl: join(pdfjsDirectory, `cmaps${sep}`),
    cMapPacked: true,
    wasmUrl: join(pdfjsDirectory, `wasm${sep}`),
  });
}

/** Share the parser's PDF.js worker with OCR rendering to avoid version conflicts. */
export async function renderPdfPages(buffer: Buffer, scale: number): Promise<Buffer[]> {
  const parser = await createParser(buffer);
  try {
    const result = await parser.getScreenshot({ scale, imageBuffer: true, imageDataUrl: false });
    return result.pages.map((page) => Buffer.from(page.data));
  } finally {
    await parser.destroy();
  }
}

/** Keep the extraction service's text/metadata contract across pdf-parse versions. */
export async function parsePdf(
  buffer: Buffer,
  timeoutMs = Number(process.env.PDF_PARSE_TIMEOUT_MS || 60_000),
): Promise<{ text: string; numpages: number; info: Record<string, unknown> }> {
  const parser = await createParser(buffer);
  const operation = (async () => {
    try {
      // Sequential calls share one loaded document. Page markers are not resume content.
      const text = await parser.getText({ pageJoiner: '' });
      const metadata = await parser.getInfo();
      return { text: text.text, numpages: metadata.total, info: metadata.info ?? {} };
    } finally {
      // Also runs if a document finishes loading after the caller has timed out.
      await parser.destroy();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`pdf-parse timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (timedOut) await parser.destroy();
  }
}
