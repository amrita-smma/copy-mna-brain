/**
 * Pre-save check for an insight template's HTML, run in the browser by the
 * upload and replace flows. Pure and client-safe: node-html-parser plus the
 * client-safe size cap — no Buffer, and none of the server-side insight
 * guards (documentGuard / structuralCheck).
 *
 * Errors block the save; warnings are shown but the user may save anyway.
 */

import { NodeType, type HTMLElement } from 'node-html-parser';
import {
  TOO_DEEPLY_NESTED_MESSAGE,
  isTooDeeplyNested,
  parseInsightHtml,
} from '@/lib/insights/parseHtml';
import {
  INSIGHT_TEMPLATE_MAX_CHARS,
  formatTemplateTooLargeMessage,
} from '@/lib/insights/templateAttachment';

export interface TemplateCheckResult {
  errors: string[];
  warnings: string[];
}

export const NO_SECTIONS_WARNING =
  "No element has a data-section attribute. Copilot can build from it, but section edits and refresh can't target sections.";

const COMPLETE_COMMENTS_RE = /<!--[\s\S]*?-->/g;
const COMPLETE_SCRIPT_RE = /<script\b[\s\S]*?<\/script\s*>/gi;
const COMPLETE_STYLE_RE = /<style\b[\s\S]*?<\/style\s*>/gi;

/**
 * Structural warnings for a document that looks cut off: an unclosed
 * `<html>`/`<body>` or an empty body. Tags are counted in the raw source
 * because node-html-parser auto-closes them.
 */
export function structureWarnings(html: string, root: HTMLElement): string[] {
  const stripped = html
    .replace(COMPLETE_COMMENTS_RE, '')
    .replace(COMPLETE_SCRIPT_RE, '')
    .replace(COMPLETE_STYLE_RE, '');
  const warnings: string[] = [];

  if (/<html\b/i.test(stripped) && !/<\/html\s*>/i.test(stripped)) {
    warnings.push('The <html> tag is never closed, so the file may be cut off.');
  }
  if (/<body\b/i.test(stripped) && !/<\/body\s*>/i.test(stripped)) {
    warnings.push('The <body> tag is never closed, so the file may be cut off.');
  }

  const target = root.querySelector('body') ?? root;
  const hasElement = target.childNodes.some((node) => node.nodeType === NodeType.ELEMENT_NODE);
  if (!hasElement && target.text.trim().length === 0) {
    warnings.push('The document body is empty, so it renders blank.');
  }
  return warnings;
}

export function checkTemplateHtml(html: string): TemplateCheckResult {
  if (!html || html.trim().length === 0) {
    return { errors: ['The file is empty.'], warnings: [] };
  }
  if (html.length > INSIGHT_TEMPLATE_MAX_CHARS) {
    return { errors: [formatTemplateTooLargeMessage(html.length)], warnings: [] };
  }

  const root = parseInsightHtml(html);
  if (isTooDeeplyNested(root)) {
    return { errors: [TOO_DEEPLY_NESTED_MESSAGE], warnings: [] };
  }
  const warnings = structureWarnings(html, root);
  if (!root.querySelector('[data-section]')) {
    warnings.push(NO_SECTIONS_WARNING);
  }
  return { errors: [], warnings };
}
