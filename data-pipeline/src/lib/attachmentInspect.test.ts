import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {
  inspectPdf,
  officeSizeRefusal,
  xlsxTextPrefix,
  zipEntrySizes,
  OFFICE_MAX_XML_BYTES,
  PDF_MAX_TRIAGE_PAGES,
  XLSX_MAX_SHARED_STRINGS_BYTES,
} from './attachmentInspect';

async function pdfWithPages(pages: number, opts: { classicTrailer?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save({ useObjectStreams: !opts.classicTrailer }));
}

describe('inspectPdf', () => {
  it('accepts a readable PDF and reports its page count', async () => {
    expect(await inspectPdf(await pdfWithPages(3))).toEqual({ ok: true, pages: 3 });
  });

  it('refuses bytes that are not a PDF', async () => {
    expect(await inspectPdf(Buffer.from('definitely not a pdf'))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an encrypted PDF', async () => {
    const plain = (await pdfWithPages(1, { classicTrailer: true })).toString('latin1');
    // Point the trailer's /Encrypt at an existing object: pdf-lib treats the
    // file as encrypted without needing a real security handler.
    const encrypted = plain.replace(/trailer\s*<</, (m) => `${m}\n/Encrypt 1 0 R`);
    expect(encrypted).not.toBe(plain);
    expect(await inspectPdf(Buffer.from(encrypted, 'latin1'))).toEqual({
      ok: false,
      reason: 'encrypted',
    });
  });

  it('refuses a PDF longer than Anthropic can read', async () => {
    expect(await inspectPdf(await pdfWithPages(PDF_MAX_TRIAGE_PAGES + 1))).toEqual({
      ok: false,
      reason: 'too_many_pages',
      pages: PDF_MAX_TRIAGE_PAGES + 1,
    });
  });
});

describe('zipEntrySizes', () => {
  it('reads each entry\'s uncompressed size from the zip directory', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', 'x'.repeat(10_000));
    zip.file('word/media/image1.png', Buffer.alloc(2_000, 1));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    const sizes = await zipEntrySizes(bytes);

    expect(bytes.length).toBeLessThan(10_000);
    expect(sizes.get('word/document.xml')).toBe(10_000);
    expect(sizes.get('word/media/image1.png')).toBe(2_000);
  });

  it('throws on bytes that are not a zip', async () => {
    await expect(zipEntrySizes(Buffer.from('not a zip'))).rejects.toThrow();
  });
});

describe('officeSizeRefusal', () => {
  it('refuses a document whose XML inflates past the cap; media does not count', () => {
    expect(
      officeSizeRefusal(false, new Map([['word/document.xml', OFFICE_MAX_XML_BYTES + 1]])),
    ).toBe('xml_too_large');
    expect(
      officeSizeRefusal(
        false,
        new Map([
          ['word/document.xml', 1_000],
          ['word/media/scan.png', OFFICE_MAX_XML_BYTES * 2],
        ]),
      ),
    ).toBeNull();
  });

  it('only limits a workbook\'s shared strings — sheets are streamed', () => {
    expect(
      officeSizeRefusal(
        true,
        new Map([['xl/sharedStrings.xml', XLSX_MAX_SHARED_STRINGS_BYTES + 1]]),
      ),
    ).toBe('shared_strings_too_large');
    expect(
      officeSizeRefusal(true, new Map([['xl/worksheets/sheet1.xml', OFFICE_MAX_XML_BYTES * 2]])),
    ).toBeNull();
  });
});

describe('xlsxTextPrefix', () => {
  async function workbook(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const model = wb.addWorksheet('Model');
    model.addRow(['Project Nova', 'Revenue', 'EBITDA']);
    model.addRow([{ richText: [{ text: 'Rich ' }, { text: 'label' }] }, { formula: '1+1', result: 2 }]);
    for (let i = 0; i < 2_000; i++) model.addRow([`row ${i}`, i, i * 2]);
    wb.addWorksheet('Later').addRow(['never reached']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('returns the first rows as tab-separated text, rich text and formula results included', async () => {
    const text = await xlsxTextPrefix(await workbook(), 10_000);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Project Nova\tRevenue\tEBITDA');
    expect(lines[1]).toBe('Rich label\t2');
  });

  it('stops at the prefix length instead of reading the whole workbook', async () => {
    const text = await xlsxTextPrefix(await workbook(), 500);
    expect(text.length).toBe(500);
    expect(text).not.toContain('never reached');
  });
});
