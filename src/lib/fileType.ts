export type FileKind =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'image'
  | 'text'
  | 'markdown'
  | 'video'
  | 'audio'
  | 'unknown';

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
  // Video and audio: the containers browsers can play natively in a
  // <video>/<audio> element. `.mov` is QuickTime, which plays in Safari and in
  // Chromium when the stream is H.264 — the common case for screen and phone
  // recordings.
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  ogv: 'video',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wav: 'audio',
  oga: 'audio',
  ogg: 'audio',
  opus: 'audio',
  flac: 'audio',
  weba: 'audio',
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

/** Video and audio — played rather than read, and never sent through text extraction. */
export function isMediaFileKind(kind: FileKind): boolean {
  return kind === 'video' || kind === 'audio';
}

/**
 * Which uploaded files can be a company's Featured Slide: a deck (PDF / PPTX)
 * or a recording (video / audio). A YouTube link can be featured too, but that
 * is a `deal_links` row, not a file — see `isYouTubeVideoUrl`.
 */
export function isFeaturableFileKind(kind: FileKind): boolean {
  return kind === 'pdf' || kind === 'pptx' || isMediaFileKind(kind);
}

/** The `accept` attribute for a Featured Slide file input — mirrors `isFeaturableFileKind`. */
export const FEATURED_SLIDE_ACCEPT = [
  '.pdf',
  '.pptx',
  '.ppt',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'video/*',
  'audio/*',
  ...Object.entries(EXTENSION_KIND)
    .filter(([, kind]) => isMediaFileKind(kind))
    .map(([ext]) => `.${ext}`),
].join(',');
