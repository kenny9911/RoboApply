import { pdfService } from './PDFService.js';
import { logger } from './LoggerService.js';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';
import { convert as htmlToText } from 'html-to-text';

export type SupportedFormat = 'pdf' | 'docx' | 'doc' | 'xlsx' | 'csv' | 'html' | 'txt' | 'md' | 'json' | 'image' | 'unknown';

// Image MIME types accepted for resume upload. Routed through PDFService's
// vision-LLM extractor (same model that handles low-quality PDF scans).
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',     // non-standard but seen in the wild
  'image/webp',
  'image/heic',
  'image/heif',
]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'heic',
  'heif',
]);

/**
 * Sniff if a buffer is HTML — handles plain HTML and Word-as-HTML
 * (Microsoft "Save as Web Page" output, common from Chinese job boards
 * like 智联招聘 / 51job that ship resumes with a `.doc` extension).
 * Skips a UTF-8 BOM if present and tolerates leading whitespace.
 */
/**
 * Decode an HTML buffer using its declared charset. Reads the first 2KB as
 * latin1 (always safe since charset declarations are pure ASCII), looks for
 * `<meta http-equiv=Content-Type content="...; charset=XYZ">` or
 * `<meta charset="XYZ">` or an XML prolog `encoding="XYZ"`. Falls back to
 * UTF-8 then latin1 when nothing is declared or the declared charset can't
 * be decoded.
 */
function decodeHtmlBuffer(buffer: Buffer, requestId?: string): string {
  const head = buffer.slice(0, Math.min(2048, buffer.length)).toString('latin1');
  const metaContent = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
  const xmlProlog = head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i);
  const declared = (metaContent?.[1] || xmlProlog?.[1] || '').toLowerCase();

  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      // GB2312 ⊂ GBK ⊂ GB18030 — always pick the widest superset to avoid
      // U+FFFD replacement chars on extended-range characters.
      const labelMap: Record<string, string> = {
        'gb2312': 'gb18030',
        'gbk': 'gb18030',
        'gb18030': 'gb18030',
        'big5': 'big5',
        'big5-hkscs': 'big5',
        'shift_jis': 'shift_jis',
        'shift-jis': 'shift_jis',
        'euc-jp': 'euc-jp',
        'euc-kr': 'euc-kr',
        'iso-8859-1': 'iso-8859-1',
        'windows-1252': 'windows-1252',
      };
      const label = labelMap[declared] || declared;
      const decoder = new TextDecoder(label, { fatal: false });
      const decoded = decoder.decode(buffer);
      logger.info('DOC_PARSE', `Decoded HTML with declared charset ${declared} (mapped to ${label})`, {}, requestId);
      return decoded;
    } catch (err) {
      logger.warn('DOC_PARSE', `TextDecoder failed for charset ${declared}, falling back to UTF-8: ${(err as Error).message}`, {}, requestId);
    }
  }

  let html = buffer.toString('utf-8');
  if (html.includes('�')) {
    logger.info('DOC_PARSE', 'UTF-8 decode produced replacement chars, falling back to latin1', {}, requestId);
    html = buffer.toString('latin1');
  }
  return html;
}

function looksLikeHtml(buffer: Buffer): boolean {
  if (buffer.length < 5) return false;
  let start = 0;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) start = 3;
  while (start < buffer.length && (buffer[start] === 0x20 || buffer[start] === 0x09 || buffer[start] === 0x0a || buffer[start] === 0x0d)) {
    start++;
  }
  const head = buffer.slice(start, Math.min(start + 256, buffer.length)).toString('utf8').toLowerCase();
  return head.startsWith('<!doctype html')
    || head.startsWith('<html')
    || head.startsWith('<?xml')
    || head.startsWith('<?mso')
    || head.startsWith('<meta')
    || head.startsWith('<head');
}

/**
 * Unified document parsing service that extracts text from PDF, DOCX, XLSX, and TXT files.
 * Supports i18n / UTF-8 content (CJK, accented characters, etc.)
 * All methods propagate requestId for end-to-end logging.
 */
export class DocumentParsingService {
  /**
   * Detect the format from MIME type or file extension.
   */
  detectFormat(mimetype: string, filename?: string): SupportedFormat {
    const mime = (mimetype || '').toLowerCase();
    if (mime === 'application/pdf') return 'pdf';
    // Modern .docx (OOXML)
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    // Legacy .doc (Word 97-2003 binary format) — uses `application/msword` mime
    if (mime === 'application/msword') {
      // If filename ends in .docx, prefer that (some servers send the legacy mime for both)
      if (filename && filename.toLowerCase().endsWith('.docx')) return 'docx';
      return 'doc';
    }
    if (
      mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime === 'application/vnd.ms-excel'
    ) return 'xlsx';
    if (mime === 'text/csv' || mime === 'application/csv') return 'csv';
    if (mime === 'text/plain') return 'txt';
    if (mime === 'text/markdown' || mime === 'text/x-markdown' || mime === 'application/x-markdown') return 'md';
    if (mime === 'application/json') return 'json';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
    // Image resumes — PNG / JPG photos & scans. Routed through PDFService's
    // vision-LLM extractor. See docs/prd-byok.md for the upstream vision flow.
    if (SUPPORTED_IMAGE_MIME_TYPES.has(mime)) return 'image';

    // Fallback: check file extension
    if (filename) {
      const ext = filename.toLowerCase().split('.').pop();
      if (ext === 'pdf') return 'pdf';
      if (ext === 'docx') return 'docx';
      if (ext === 'doc') return 'doc';
      if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
      if (ext === 'csv') return 'csv';
      if (ext === 'txt') return 'txt';
      if (ext === 'md' || ext === 'markdown') return 'md';
      if (ext === 'json') return 'json';
      if (ext === 'html' || ext === 'htm' || ext === 'mht' || ext === 'mhtml') return 'html';
      if (ext && SUPPORTED_IMAGE_EXTENSIONS.has(ext)) return 'image';
    }

    return 'unknown';
  }

  static isAcceptedUpload(mimetype: string, filename?: string): boolean {
    const parser = new DocumentParsingService();
    return parser.detectFormat(mimetype, filename) !== 'unknown';
  }

  /**
   * Extract text from a file buffer based on its format.
   * Logs every step for debuggability.
   */
  async extractText(buffer: Buffer, mimetype: string, filename?: string, requestId?: string): Promise<string> {
    const format = this.detectFormat(mimetype, filename);

    logger.info('DOC_PARSE', `Starting extraction: format=${format}`, {
      filename, mimetype, bufferSize: buffer.length,
    }, requestId);

    const startTime = Date.now();

    try {
      let text: string;

      switch (format) {
        case 'pdf':
          logger.info('DOC_PARSE', 'Delegating to PDFService.extractText (with LLM vision fallback)', {}, requestId);
          text = await pdfService.extractText(buffer, requestId);
          break;
        case 'docx':
          text = await this.extractDocx(buffer, requestId);
          break;
        case 'doc':
          text = await this.extractLegacyDoc(buffer, requestId);
          break;
        case 'xlsx':
          text = this.extractXlsx(buffer, requestId);
          break;
        case 'csv':
          text = this.extractCsv(buffer, requestId);
          break;
        case 'txt':
          text = this.extractTxt(buffer, requestId);
          break;
        case 'md':
          text = this.extractMarkdown(buffer, requestId);
          break;
        case 'json':
          text = this.extractJson(buffer, requestId);
          break;
        case 'html':
          text = this.extractHtml(buffer, requestId);
          break;
        case 'image':
          text = await this.extractImage(buffer, mimetype, requestId);
          break;
        default:
          throw new Error(`Unsupported file format: ${mimetype} (detected: ${format})`);
      }

      const elapsedMs = Date.now() - startTime;
      logger.info('DOC_PARSE', `Extraction complete: ${text.length} chars in ${elapsedMs}ms`, {
        format, chars: text.length, lines: text.split('\n').length, elapsedMs,
        preview: text.substring(0, 120),
      }, requestId);

      return text;
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('DOC_PARSE', `Extraction failed after ${elapsedMs}ms: ${errMsg}`, {
        format, filename, elapsedMs,
        stack: error instanceof Error ? error.stack : undefined,
      }, requestId);
      throw error;
    }
  }

  /**
   * Extract text from DOCX using mammoth.
   * mammoth handles UTF-8/CJK/i18n content natively.
   * If the buffer is actually a legacy .doc file (OLE compound, magic D0CF11E0),
   * fall back to the legacy extractor automatically.
   */
  private async extractDocx(buffer: Buffer, requestId?: string): Promise<string> {
    logger.info('DOC_PARSE', 'Extracting DOCX with mammoth', {}, requestId);

    // DOCX files are ZIP archives, starting with "PK" (0x50 0x4B)
    const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    // Legacy .doc files start with the OLE compound document signature 0xD0CF11E0
    const isOleCompound = buffer.length >= 4
      && buffer[0] === 0xd0 && buffer[1] === 0xcf
      && buffer[2] === 0x11 && buffer[3] === 0xe0;

    if (!isZip && isOleCompound) {
      logger.info('DOC_PARSE', 'Detected legacy .doc file (OLE compound) — using word-extractor', {}, requestId);
      return this.extractLegacyDoc(buffer, requestId);
    }
    if (!isZip && looksLikeHtml(buffer)) {
      logger.info('DOC_PARSE', 'Detected HTML disguised as .docx (Word "Save as Web Page") — using html-to-text', {}, requestId);
      return this.extractHtml(buffer, requestId);
    }
    if (!isZip) {
      throw new Error('Unrecognized Word document format (expected .docx ZIP or legacy .doc OLE compound)');
    }

    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();

    if (result.messages?.length) {
      logger.warn('DOC_PARSE', `mammoth warnings: ${result.messages.length}`, {
        warnings: result.messages.slice(0, 5).map(m => m.message),
      }, requestId);
    }

    if (!text) {
      logger.warn('DOC_PARSE', 'mammoth returned empty text', {}, requestId);
      throw new Error('No text content found in DOCX file');
    }

    logger.info('DOC_PARSE', `DOCX extracted: ${text.length} chars`, {}, requestId);
    return text;
  }

  /**
   * Extract text from a legacy .doc (Word 97-2003 binary / OLE compound) file.
   * Uses word-extractor which parses the OLE structure in pure JS.
   */
  private async extractLegacyDoc(buffer: Buffer, requestId?: string): Promise<string> {
    // Many resume sources (Chinese job boards, recruiter exports) stamp a `.doc`
    // extension on Word "Save as Web Page" output, which is HTML — not OLE compound.
    // Sniff before handing to word-extractor (which would throw on HTML).
    if (looksLikeHtml(buffer)) {
      logger.info('DOC_PARSE', 'Detected HTML disguised as .doc (Word "Save as Web Page") — using html-to-text', {}, requestId);
      return this.extractHtml(buffer, requestId);
    }
    // Some sources also ship a real .docx ZIP under a `.doc` extension.
    const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (isZip) {
      logger.info('DOC_PARSE', 'Detected .docx ZIP under .doc extension — delegating to mammoth', {}, requestId);
      return this.extractDocx(buffer, requestId);
    }

    logger.info('DOC_PARSE', 'Extracting legacy .doc with word-extractor', {}, requestId);

    const extractor = new WordExtractor();
    const extracted = await extractor.extract(buffer);
    // word-extractor returns an object with getBody(), getHeaders(), getFooters(), etc.
    // We concatenate body + headers + footers to capture all text.
    const body = (extracted?.getBody?.() || '').toString();
    const headers = (extracted?.getHeaders?.() || '').toString();
    const footers = (extracted?.getFooters?.() || '').toString();
    const text = [body, headers, footers].filter((s) => s.trim()).join('\n\n').trim();

    if (!text) {
      logger.warn('DOC_PARSE', 'word-extractor returned empty text', {}, requestId);
      throw new Error('No text content found in legacy .doc file');
    }

    logger.info('DOC_PARSE', `Legacy .doc extracted: ${text.length} chars`, {}, requestId);
    return text;
  }

  /**
   * Extract text from an HTML file (or Word "Save as Web Page" output).
   * Word's MSO HTML uses `<o:p>`, `<v:*>`, `mso-*` style tags and lots of
   * nested tables — html-to-text strips them and preserves table layout
   * better than a regex strip. Honours the declared charset (Chinese job
   * boards typically emit GB2312/GBK), falling back to UTF-8 then latin1.
   */
  private extractHtml(buffer: Buffer, requestId?: string): string {
    logger.info('DOC_PARSE', 'Extracting HTML with html-to-text', {}, requestId);

    const html = decodeHtmlBuffer(buffer, requestId);

    const text = htmlToText(html, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'head', format: 'skip' },
      ],
    }).trim();

    if (!text) {
      logger.warn('DOC_PARSE', 'html-to-text returned empty text', {}, requestId);
      throw new Error('No text content found in HTML file');
    }

    logger.info('DOC_PARSE', `HTML extracted: ${text.length} chars`, {}, requestId);
    return text;
  }

  /**
   * Extract text from XLSX (Excel) spreadsheets.
   * Reads all sheets and concatenates cell values.
   */
  private extractXlsx(buffer: Buffer, requestId?: string): string {
    logger.info('DOC_PARSE', 'Extracting XLSX', {}, requestId);
    const workbook = XLSX.read(buffer, { type: 'buffer', codepage: 65001 /* UTF-8 */ });

    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (workbook.SheetNames.length > 1) {
        parts.push(`[${sheetName}]`);
      }

      for (const row of rows) {
        const line = row
          .map((cell) => String(cell ?? '').trim())
          .filter(Boolean)
          .join('\t');
        if (line) parts.push(line);
      }

      parts.push('');
    }

    const text = parts.join('\n').trim();
    if (!text) {
      throw new Error('No text content found in Excel file');
    }

    logger.info('DOC_PARSE', `XLSX extracted: ${text.length} chars, ${workbook.SheetNames.length} sheets`, {}, requestId);
    return text;
  }

  /**
   * Extract text from CSV files as plain text.
   */
  private extractCsv(buffer: Buffer, requestId?: string): string {
    logger.info('DOC_PARSE', 'Extracting CSV as text', {}, requestId);
    const text = buffer.toString('utf-8');
    if (!text.trim()) throw new Error('CSV file is empty');
    logger.info('DOC_PARSE', `CSV extracted: ${text.length} chars`, {}, requestId);
    return text;
  }

  /**
   * Extract text from plain text files.
   * Tries UTF-8 first, falls back to Latin-1.
   */
  private extractTxt(buffer: Buffer, requestId?: string): string {
    let text = buffer.toString('utf-8');

    if (text.includes('\uFFFD')) {
      logger.info('DOC_PARSE', 'UTF-8 decode had replacement chars, falling back to Latin-1', {}, requestId);
      text = buffer.toString('latin1');
    }

    return text.trim();
  }

  /**
   * Extract text from Markdown files.
   */
  private extractMarkdown(buffer: Buffer, requestId?: string): string {
    const raw = this.extractTxt(buffer, requestId);
    return DocumentParsingService.stripMarkdown(raw);
  }

  /**
   * Strip markdown formatting from text, returning plain text.
   */
  static stripMarkdown(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, '$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/^[-*_]{3,}\s*$/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/^[\s]*[-*+]\s+/gm, '')
      .replace(/^[\s]*\d+\.\s+/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Extract readable text from JSON files.
   */
  private extractJson(buffer: Buffer, requestId?: string): string {
    const raw = buffer.toString('utf-8').trim();
    try {
      const parsed = JSON.parse(raw);
      const flattened = DocumentParsingService.flattenJson(parsed);
      logger.info('DOC_PARSE', `JSON extracted and flattened: ${flattened.length} chars`, {}, requestId);
      return flattened;
    } catch {
      logger.warn('DOC_PARSE', 'JSON parse failed, returning raw text', {}, requestId);
      return raw;
    }
  }

  /**
   * Flatten a JSON value into human-readable text.
   */
  static flattenJson(value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if ('data' in obj && obj.data && typeof obj.data === 'object') {
        value = obj.data;
      }
    }

    const lines: string[] = [];

    const walk = (v: unknown, prefix: string) => {
      if (v === null || v === undefined || v === '') return;
      if (typeof v === 'string') {
        lines.push(prefix ? `${prefix}: ${v}` : v);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        lines.push(prefix ? `${prefix}: ${v}` : String(v));
      } else if (Array.isArray(v)) {
        for (const item of v) {
          walk(item, prefix);
        }
      } else if (typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          walk(child, prefix ? `${prefix} > ${k}` : k);
        }
      }
    };

    walk(value, '');
    return lines.join('\n').trim() || JSON.stringify(value, null, 2);
  }

  /**
   * Detect and clean JSON or markdown from arbitrary text input.
   */
  static cleanTextContent(text: string): string {
    if (!text || typeof text !== 'string') return text;
    const trimmed = text.trim();

    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        const flattened = DocumentParsingService.flattenJson(parsed);
        if (flattened) return flattened;
      } catch {
        // Not valid JSON, continue
      }
    }

    const mdMarkers = (trimmed.match(/^#{1,6}\s|```|\*\*|__|\[.+\]\(.+\)/gm) || []).length;
    if (mdMarkers >= 3) {
      return DocumentParsingService.stripMarkdown(trimmed);
    }

    return trimmed;
  }

  /**
   * Extract text from a raster image (PNG / JPG photo or scan of a resume).
   *
   * Delegates to PDFService.extractImage which uses the same vision-LLM
   * pipeline that handles low-quality scanned PDFs. Output is plain text
   * suitable for the downstream ResumeParseAgent — no special handling
   * needed by the caller.
   *
   * Throws if the vision call fails outright. Empty-string returns are
   * possible when the image had no readable text; the route handler
   * surfaces that to the user as "couldn't read this image".
   */
  private async extractImage(buffer: Buffer, mimetype: string, requestId?: string): Promise<string> {
    logger.info('DOC_PARSE', 'Delegating image extraction to PDFService.extractImage', {
      mimetype,
      bufferSize: buffer.length,
    }, requestId);
    return pdfService.extractImage(buffer, mimetype, requestId);
  }

  /**
   * List of accepted MIME types for multer fileFilter.
   */
  static ACCEPTED_MIMES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/csv',
    'text/plain',
    'text/markdown',
    'application/json',
    'text/html',
    'application/xhtml+xml',
    // Image resumes (photos / scans). Routed through the vision LLM.
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/heic',
    'image/heif',
  ]);
}

export const documentParsingService = new DocumentParsingService();
