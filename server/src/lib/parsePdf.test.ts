// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { PDFParse } from 'pdf-parse';
import { parsePdf, renderPdfPages } from './parsePdf.js';

async function resumePdf(): Promise<Buffer> {
  const doc = new PDFDocument({ info: { Title: 'Resume fixture', Author: 'Test Candidate' } });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.text('Test Candidate\nSoftware Engineer');
  doc.addPage().text('Experience\nBuilt reliable document processing systems.');
  doc.end();
  return complete;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('pdf-parse integration', () => {
  it('extracts every page and metadata without modifying the OCR input', async () => {
    const buffer = await resumePdf();
    const original = Buffer.from(buffer);
    const destroy = vi.spyOn(PDFParse.prototype, 'destroy');
    const result = await parsePdf(buffer);
    expect(result.numpages).toBe(2);
    expect(result.text).toContain('Software Engineer');
    expect(result.text).toContain('Built reliable document processing systems.');
    expect(result.text).not.toMatch(/--\s*\d+ of \d+\s*--/);
    expect(result.info).toMatchObject({ Title: 'Resume fixture', Author: 'Test Candidate' });
    expect(buffer).toEqual(original);
    expect(destroy).toHaveBeenCalledOnce();
    // A second parser must also be able to read the same original buffer.
    expect((await parsePdf(buffer)).numpages).toBe(2);
  });

  it('releases parser resources when a malformed PDF fails', async () => {
    const destroy = vi.spyOn(PDFParse.prototype, 'destroy');
    await expect(parsePdf(Buffer.from('not a PDF'))).rejects.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps the same PDF usable by the image OCR fallback', async () => {
    const buffer = await resumePdf();
    await parsePdf(buffer);
    const destroy = vi.spyOn(PDFParse.prototype, 'destroy');
    const images = await renderPdfPages(buffer, 1);
    expect(images).toHaveLength(2);
    for (const image of images) expect(image.subarray(1, 4).toString()).toBe('PNG');
    const scaled = await renderPdfPages(buffer, 2);
    expect(scaled[0].readUInt32BE(16)).toBe(images[0].readUInt32BE(16) * 2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect((await parsePdf(buffer)).numpages).toBe(2);
  });

  it('bounds asynchronous parsing and cleans up a load that settles after timeout', async () => {
    let rejectLoad!: (error: Error) => void;
    vi.spyOn(PDFParse.prototype, 'getText').mockImplementation(() => new Promise((_, reject) => {
      rejectLoad = reject;
    }));
    const destroy = vi.spyOn(PDFParse.prototype, 'destroy').mockResolvedValue();
    await expect(parsePdf(Buffer.from('pending PDF'), 5)).rejects.toThrow('timed out after 5ms');
    expect(destroy).toHaveBeenCalledOnce();
    rejectLoad(new Error('load stopped'));
    await vi.waitFor(() => { expect(destroy).toHaveBeenCalledTimes(2); });
  });
});
