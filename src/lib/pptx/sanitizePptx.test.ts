import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { sanitizePptxForOfficeOnline } from './sanitizePptx';

async function buildBrokenPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip.file('ppt/presentation.xml', '<p/>');
  zip.file('ppt/slideMasters/slideMaster1.xml', '<m/>');
  zip.file('ppt/slides/slide1.xml', '<s/>');
  // phantom master2 intentionally omitted
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('sanitizePptxForOfficeOnline', () => {
  it('strips Content_Types Overrides for missing parts', async () => {
    const input = await buildBrokenPptx();
    const { buffer, removedPartNames } = await sanitizePptxForOfficeOnline(input);

    expect(removedPartNames).toEqual(['ppt/slideMasters/slideMaster2.xml']);

    const zip = await JSZip.loadAsync(buffer);
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('slideMaster1.xml');
    expect(ct).not.toContain('slideMaster2.xml');
    expect(ct).toContain('slide1.xml');
  });

  it('keeps all real parts when the zip has directory entries (Claude-style)', async () => {
    const zip = new JSZip();
    // Explicit directory markers — Claude's packer includes these.
    zip.folder('ppt');
    zip.folder('ppt/slides');
    zip.folder('ppt/slideMasters');
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
    );
    zip.file('ppt/presentation.xml', '<p>presentation</p>');
    zip.file('ppt/slideMasters/slideMaster1.xml', '<m>master</m>');
    zip.file('ppt/slides/slide1.xml', '<s>slide body content that must survive</s>');
    const input = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));

    const { buffer, removedPartNames } = await sanitizePptxForOfficeOnline(input);
    expect(removedPartNames).toEqual(['ppt/slideMasters/slideMaster2.xml']);

    const out = await JSZip.loadAsync(buffer);
    const files = Object.keys(out.files).filter((n) => !out.files[n].dir);
    expect(files.sort()).toEqual(
      [
        '[Content_Types].xml',
        'ppt/presentation.xml',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slides/slide1.xml',
      ].sort(),
    );
    expect(await out.file('ppt/slides/slide1.xml')!.async('string')).toContain(
      'must survive',
    );
    expect(buffer.length).toBeGreaterThan(200);
  });

  it('keeps Overrides whose PartName is URI-encoded vs JSZip decoded keys', async () => {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/ppt/media/image%201.png" ContentType="image/png"/>
  <Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
</Types>`,
    );
    zip.file('ppt/media/image 1.png', Buffer.from([1, 2, 3, 4]));
    const input = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));

    const { buffer, removedPartNames } = await sanitizePptxForOfficeOnline(input);
    expect(removedPartNames).toEqual(['ppt/slideMasters/slideMaster2.xml']);
    const out = await JSZip.loadAsync(buffer);
    const ct = await out.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('image%201.png');
    expect(ct).not.toContain('slideMaster2');
  });
});
