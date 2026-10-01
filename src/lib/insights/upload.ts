/**
 * The rules for uploading an HTML file as a new insight (MB-635), shared by
 * the upload page and `POST /api/insights/upload`. Pure and client-safe:
 * node-html-parser, the size cap and the CSP's host allowlist — no Buffer and
 * none of the server-side insight guards.
 *
 * Errors block the upload; warnings are shown but the user may upload anyway.
 * The server re-checks size and emptiness, and is the only one to check the
 * source markers (see `InsightService.uploadDocument`).
 */
import type { HTMLElement } from 'node-html-parser';
import {
  TOO_DEEPLY_NESTED_MESSAGE,
  isTooDeeplyNested,
  parseInsightHtml,
} from '@/lib/insights/parseHtml';
import {
  INSIGHT_CDN_HOSTS,
  INSIGHT_FONT_STYLE_HOSTS,
  MAX_INSIGHT_BYTES,
} from '@/lib/insights/srcdoc';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/srcdoc';
import { structureWarnings, type TemplateCheckResult } from '@/lib/insights/templateCheck';

export const ALLOWED_INSIGHT_UPLOAD_EXTENSIONS = ['.html', '.htm'] as const;

export const INVALID_INSIGHT_UPLOAD_TYPE_MESSAGE =
  'Invalid file type. Only HTML files (.html, .htm) are supported.';
export const EMPTY_INSIGHT_UPLOAD_MESSAGE = 'The file is empty.';

export function isValidInsightUploadExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ALLOWED_INSIGHT_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function insightUploadTooLargeMessage(bytes: number): string {
  const size = formatMegabytes(bytes);
  const cap = formatMegabytes(MAX_INSIGHT_BYTES);
  // A file a few bytes over would otherwise read "4.0 MB; limited to 4 MB".
  const actual = Number.parseFloat(size) <= Number.parseFloat(cap) ? `just over ${cap}` : size;
  return `The file is ${actual}; insights are limited to ${cap}.`;
}

/** The size, in UTF-8 bytes, the server will measure. */
function utf8Bytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

const SCRIPT_SRC_RE = /^https?:\/\//i;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Warnings for what the insight frame's policy will block: scripts and
 * stylesheets from hosts off the allowlist, and images loaded from the web
 * (only embedded `data:`/`blob:` images render).
 */
function blockedResourceWarnings(root: HTMLElement): string[] {
  const scriptHosts: ReadonlySet<string> = new Set(INSIGHT_CDN_HOSTS);
  const styleHosts: ReadonlySet<string> = new Set([
    ...INSIGHT_CDN_HOSTS,
    ...INSIGHT_FONT_STYLE_HOSTS,
  ]);
  const blocked = new Set<string>();

  for (const el of root.querySelectorAll('script[src]')) {
    const src = el.getAttribute('src') ?? '';
    const origin = SCRIPT_SRC_RE.test(src) ? originOf(src) : null;
    if (!origin || !scriptHosts.has(origin)) blocked.add(origin ?? src);
  }
  for (const el of root.querySelectorAll('link[href]')) {
    if (!/\bstylesheet\b/i.test(el.getAttribute('rel') ?? '')) continue;
    const href = el.getAttribute('href') ?? '';
    const origin = SCRIPT_SRC_RE.test(href) ? originOf(href) : null;
    if (!origin || !styleHosts.has(origin)) blocked.add(origin ?? href);
  }

  const warnings: string[] = [];
  if (blocked.size > 0) {
    const list = [...blocked].slice(0, 3).join(', ');
    const more = blocked.size > 3 ? ` and ${blocked.size - 3} more` : '';
    warnings.push(
      `Scripts or stylesheets from ${list}${more} will be blocked. Insights may only load them from ${INSIGHT_CDN_HOSTS.join(', ')}.`,
    );
  }

  const webImages = root
    .querySelectorAll('img[src]')
    .filter((el) => !/^(data|blob):/i.test((el.getAttribute('src') ?? '').trim())).length;
  if (webImages > 0) {
    warnings.push(
      `${webImages} ${webImages === 1 ? 'image loads' : 'images load'} from a link and won't show. Only images embedded in the file (data: URLs) render.`,
    );
  }
  return warnings;
}

/** Pre-upload check of a file's text. Errors block; warnings don't. */
export function checkInsightUploadHtml(html: string): TemplateCheckResult {
  if (!html || html.trim().length === 0) {
    return { errors: [EMPTY_INSIGHT_UPLOAD_MESSAGE], warnings: [] };
  }
  const bytes = utf8Bytes(html);
  if (bytes > MAX_INSIGHT_BYTES) {
    return { errors: [insightUploadTooLargeMessage(bytes)], warnings: [] };
  }
  const root = parseInsightHtml(html);
  if (isTooDeeplyNested(root)) {
    return { errors: [TOO_DEEPLY_NESTED_MESSAGE], warnings: [] };
  }
  return {
    errors: [],
    warnings: [...structureWarnings(html, root), ...blockedResourceWarnings(root)],
  };
}

export type InsightUploadFileResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

/**
 * Reads a picked file and applies the hard rules — an HTML file, not empty,
 * within the cap — before its text is accepted. A file far over the cap is
 * refused without reading it.
 */
export async function readInsightUploadFile(file: File): Promise<InsightUploadFileResult> {
  if (!isValidInsightUploadExtension(file.name)) {
    return { ok: false, error: INVALID_INSIGHT_UPLOAD_TYPE_MESSAGE };
  }
  if (file.size === 0) return { ok: false, error: EMPTY_INSIGHT_UPLOAD_MESSAGE };
  if (file.size > MAX_INSIGHT_BYTES) {
    return { ok: false, error: insightUploadTooLargeMessage(file.size) };
  }
  return { ok: true, html: await file.text() };
}

/** The file name without its extension, e.g. "Q3 review" for "Q3 review.html". */
function fileStem(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

/**
 * A name for an uploaded insight: the document's `<title>`, else the file
 * name without its extension, trimmed to the name cap.
 */
export function suggestInsightUploadName(fileName: string, html: string): string {
  const root = parseInsightHtml(html);
  const title = isTooDeeplyNested(root)
    ? ''
    : (root.querySelector('title')?.text.replace(/\s+/g, ' ').trim() ?? '');
  const name = title || fileStem(fileName).trim() || 'Uploaded insight';
  return name.slice(0, MAX_INSIGHT_NAME_LENGTH).trim();
}
