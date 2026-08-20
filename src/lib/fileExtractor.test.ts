import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { extractTextFromFile } from '@/lib/fileExtractor';

async function buildMinimalDocx(paragraph: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder('word')!.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildMinimalPptx(slideText: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip.folder('ppt')!.folder('slides')!.file(
    'slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${slideText}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildMinimalXlsx(cellText: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deal');
  sheet.addRow([cellText]);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe('extractTextFromFile Office formats', () => {
  it('extracts text from a minimal DOCX', async () => {
    const marker = 'Project Alpha Information Memorandum confidential';
    const buf = await buildMinimalDocx(marker);
    const text = await extractTextFromFile(
      buf,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Project_Alpha_IM.docx',
    );
    expect(text).toContain(marker);
  });

  it('extracts text from a minimal PPTX', async () => {
    const marker = 'Project Nova teaser slide overview';
    const buf = await buildMinimalPptx(marker);
    const text = await extractTextFromFile(
      buf,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Project_Nova_Teaser.pptx',
    );
    expect(text).toContain(marker);
  });

  it('extracts text from a minimal XLSX', async () => {
    const marker = 'Project Titanium LBO model assumptions';
    const buf = await buildMinimalXlsx(marker);
    const text = await extractTextFromFile(
      buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Project_Titanium_Model.xlsx',
    );
    expect(text).toContain(marker);
  });

  it('extracts rich text from XLSX without producing [object Object]', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('基金流水明细');
    sheet.addRow(['序号', '实体名称', '金额（万元）']);
    sheet.addRow([
      1,
      {
        richText: [
          { text: '高亚投资有限公司\n' },
          { text: 'GLOBE ASIA INVESTMENTS LIMITED' },
        ],
      },
      15000,
    ]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());
    const text = await extractTextFromFile(
      buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ledger.xlsx',
    );

    expect(text).not.toContain('[object Object]');
    expect(text).toContain('高亚投资有限公司\nGLOBE ASIA INVESTMENTS LIMITED');
    expect(text).toContain('15000');
  });

  it('extracts text from an XLSM file via the workbook extractor', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('MacroData');
    sheet.addRow(['Macro Header', 'Value']);
    sheet.addRow(['Special Asset', 99999]);
    const buf = Buffer.from(await workbook.xlsx.writeBuffer());

    const text = await extractTextFromFile(
      buf,
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'macro_workbook.xlsm',
    );

    expect(text).not.toContain('[object Object]');
    expect(text).toContain('Macro Header');
    expect(text).toContain('Special Asset');
    expect(text).toContain('99999');
  });
});
