import JSZip from 'jszip';

const CONTENT_TYPES_PATH = '[Content_Types].xml';

/**
 * Claude's pptx skill sometimes writes Override entries in [Content_Types].xml
 * for parts that were never packed (e.g. slideMaster2..N when only master1
 * exists). Desktop PowerPoint often repairs this; Office Online rejects the
 * file with "Sorry, we can't open this presentation".
 *
 * Strip Override PartNames that are missing from the archive, then rebuild
 * the zip from file entries only.
 *
 * IMPORTANT: do NOT call `zip.remove()` on directory entries in JSZip — that
 * cascades and deletes every file under that prefix (we shipped a 672-byte
 * empty deck that way).
 */
export async function sanitizePptxForOfficeOnline(
  buffer: Buffer,
): Promise<{ buffer: Buffer; removedPartNames: string[] }> {
  const src = await JSZip.loadAsync(buffer);
  const fileNames = Object.keys(src.files).filter((name) => !src.files[name].dir);
  const existing = new Set(fileNames);

  const ctFile = src.file(CONTENT_TYPES_PATH);
  if (!ctFile) {
    return { buffer, removedPartNames: [] };
  }

  const xml = await ctFile.async('string');
  const removedPartNames: string[] = [];

  const sanitizedXml = xml.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const partMatch = tag.match(/\bPartName="([^"]+)"/);
    if (!partMatch) return tag;
    let part = partMatch[1].replace(/^\//, '');
    // Content_Types PartNames are URI-encoded; JSZip keys are decoded.
    try {
      part = decodeURIComponent(part);
    } catch {
      // keep raw part
    }
    if (existing.has(part)) return tag;
    removedPartNames.push(part);
    return '';
  });

  if (removedPartNames.length === 0) {
    return { buffer, removedPartNames: [] };
  }

  const cleanedXml = sanitizedXml.replace(/>\s+</g, '><');

  // Rebuild from scratch so we never mutate directory entries in-place.
  const outZip = new JSZip();
  for (const name of fileNames) {
    if (name === CONTENT_TYPES_PATH) {
      outZip.file(name, cleanedXml);
      continue;
    }
    const entry = src.file(name);
    if (!entry) continue;
    outZip.file(name, await entry.async('nodebuffer'));
  }

  const out = await outZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { buffer: Buffer.from(out), removedPartNames };
}
