export type FileKind = 'pdf' | 'docx' | 'pptx' | 'image' | 'text' | 'markdown' | 'unknown';

const EXTENSION_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  pptx: 'pptx',
  ppt: 'pptx',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  txt: 'text',
  md: 'markdown',
};

/** Extension-based file kind detection — the taxonomy `FilePreview` can render. */
export function detectFileKind(fileName: string): FileKind {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_KIND[ext] ?? 'unknown';
}

/** Whether `FilePreview` (and by extension, the Presentation file picker) can render this kind at all. */
export function isPresentableFileKind(kind: FileKind): boolean {
  return kind !== 'unknown';
}
