/**
 * Bounded-memory checks on email attachments before Smart Files triage.
 *
 * The byte cap (PDF_TRIAGE_SOFT_MAX_BYTES) bounds the *compressed* file. A PDF's
 * page streams and an Office file's XML are compressed inside it, so a parser
 * that inflates everything (pdf-parse's bundled pdf.js, exceljs' full workbook
 * load) can turn an 8 MB attachment into gigabytes and kill the Lambda — which
 * then retries the same attachment forever. Everything here reads structure or
 * a bounded prefix instead.
 */

import { Readable } from 'node:stream';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import * as unzipper from 'unzipper';
import ExcelJS from 'exceljs';

/** Anthropic's page limit for a PDF document block; larger PDFs can't be triaged. */
export const PDF_MAX_TRIAGE_PAGES = 100;

/** Uncompressed XML a .docx / .pptx may hold before text extraction is refused. */
export const OFFICE_MAX_XML_BYTES = 100 * 1024 * 1024;

/** Uncompressed shared-strings table an .xlsx may hold (read whole by the stream reader). */
export const XLSX_MAX_SHARED_STRINGS_BYTES = 50 * 1024 * 1024;

export type PdfInspection =
  | { ok: true; pages: number }
  | { ok: false; reason: 'encrypted' | 'invalid' | 'too_many_pages'; pages?: number };

/**
 * Parses the PDF's object structure without decoding page content, so memory
 * stays near the file size. Encrypted, unreadable and over-long PDFs fail here
 * every time, so callers skip them instead of retrying.
 */
export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  let pages: number;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    pages = doc.getPageCount();
  } catch (err) {
    // pdf-lib 1.17 reports encryption as a plain Error, not EncryptedPDFError.
    const encrypted =
      err instanceof EncryptedPDFError || /\bis encrypted\b/i.test((err as Error)?.message ?? '');
    return { ok: false, reason: encrypted ? 'encrypted' : 'invalid' };
  }
  if (pages < 1) return { ok: false, reason: 'invalid', pages };
  if (pages > PDF_MAX_TRIAGE_PAGES) return { ok: false, reason: 'too_many_pages', pages };
  return { ok: true, pages };
}

/** Uncompressed size of each zip entry, read from the central directory only. */
export async function zipEntrySizes(bytes: Buffer): Promise<Map<string, number>> {
  const dir = await unzipper.Open.buffer(bytes);
  return new Map(dir.files.map((f) => [f.path, f.uncompressedSize]));
}

/**
 * Why an Office file's extraction would be unbounded, or null when it is safe.
 * Media (images, embedded files) is not parsed, so only XML counts.
 */
export function officeSizeRefusal(
  isSpreadsheet: boolean,
  sizes: Map<string, number>,
): 'xml_too_large' | 'shared_strings_too_large' | null {
  if (isSpreadsheet) {
    const shared = sizes.get('xl/sharedStrings.xml') ?? 0;
    return shared > XLSX_MAX_SHARED_STRINGS_BYTES ? 'shared_strings_too_large' : null;
  }
  let xml = 0;
  for (const [path, size] of sizes) {
    if (/\.(?:xml|rels)$/i.test(path)) xml += size;
  }
  return xml > OFFICE_MAX_XML_BYTES ? 'xml_too_large' : null;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
  if ('text' in value) return String(value.text);
  return '';
}

/**
 * The first `maxChars` of a workbook's cell text, one row per line, read with
 * exceljs' streaming reader and abandoned as soon as the prefix is full — the
 * whole workbook is never held in memory.
 */
export async function xlsxTextPrefix(bytes: Buffer, maxChars: number): Promise<string> {
  const source = Readable.from(bytes);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'ignore',
  });
  let text = '';
  try {
    outer: for await (const sheet of reader) {
      for await (const row of sheet as AsyncIterable<ExcelJS.Row>) {
        const values = Array.isArray(row.values) ? row.values : [];
        const line = values.map(cellText).filter(Boolean).join('\t');
        if (line) text += `${line}\n`;
        if (text.length >= maxChars) break outer;
      }
    }
  } finally {
    source.destroy();
  }
  return text.slice(0, maxChars);
}
