import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseContactWorkbook } from './contactImportExcel';

async function workbookBuffer(
  build: (wb: ExcelJS.Workbook) => void,
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe('parseContactWorkbook', () => {
  it('reads the first non-empty sheet, starting at its header row', async () => {
    const data = await workbookBuffer((wb) => {
      wb.addWorksheet('Empty');
      const ws = wb.addWorksheet('Contacts');
      ws.addRow([]);
      ws.addRow(['Full Name', 'Company', 'Email', 'Seniority', 'Phone']);
      ws.addRow(['Jane Doe', 'Goldman Sachs', 'Jane@GS.com', 'MD', 6281234]);
    });

    const out = await parseContactWorkbook(data);

    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([
      {
        name: 'Jane Doe',
        firm: 'Goldman Sachs',
        email: 'jane@gs.com',
        seniority: 'MD',
        phone: '6281234',
      },
    ]);
  });

  it('takes the link target of a hyperlinked LinkedIn cell, but the text of other linked cells', async () => {
    const data = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('Contacts');
      ws.addRow(['Name', 'LinkedIn']);
      ws.addRow([
        { text: 'Jane Doe', hyperlink: 'https://example.com/jane' },
        { text: 'Profile', hyperlink: 'https://www.linkedin.com/in/jane' },
      ]);
    });

    const out = await parseContactWorkbook(data);

    expect(out.rows).toEqual([
      { name: 'Jane Doe', linkedinUrl: 'https://www.linkedin.com/in/jane' },
    ]);
  });

  it('finds the header row below a merged banner row and keeps every column', async () => {
    const data = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('Contacts');
      ws.addRow(['© Vendor Ltd 2026. All data subject to terms.']);
      ws.mergeCells('A1:D1');
      ws.addRow(['Name', 'Firm Name', 'Email', 'LinkedIn']);
      ws.addRow([
        'Jane Doe',
        'Acme',
        'j@x.com',
        { text: 'Profile', hyperlink: 'https://www.linkedin.com/in/jane' },
      ]);
    });

    const out = await parseContactWorkbook(data);

    expect(out.errors).toEqual([]);
    expect(out.extraHeaders).toEqual([]);
    expect(out.rows).toEqual([
      {
        name: 'Jane Doe',
        firm: 'Acme',
        email: 'j@x.com',
        linkedinUrl: 'https://www.linkedin.com/in/jane',
      },
    ]);
  });

  it('reports an empty workbook', async () => {
    const data = await workbookBuffer((wb) => {
      wb.addWorksheet('Empty');
    });
    expect((await parseContactWorkbook(data)).errors).toEqual(['The workbook is empty.']);
  });

  it('pads short data rows to the header width so columns stay aligned', async () => {
    const data = await workbookBuffer((wb) => {
      const ws = wb.addWorksheet('Contacts');
      ws.addRow(['Name', 'Company', 'Email', 'Title', 'Phone']);
      ws.addRow(['Jane Doe', 'Acme', 'j@x.com']);
    });

    const out = await parseContactWorkbook(data);

    expect(out.rows).toEqual([
      {
        name: 'Jane Doe',
        firm: 'Acme',
        email: 'j@x.com',
      },
    ]);
  });
});
