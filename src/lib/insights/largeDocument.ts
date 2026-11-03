/**
 * Model-facing blocks for documents a chat turn carries: an insight template
 * attached to the message (or read with `get_insight_template`) and an HTML
 * file attached in the composer.
 *
 * Chat can inline a document of at most CHAT_INLINE_DOCUMENT_MAX_CHARS in one
 * turn, but never creates an insight from it — new insights always go to the
 * Workforce. A larger one never reaches the
 * model whole in chat: it becomes a bounded outline of its sections plus a
 * hard instruction to hand the work to the Workforce, which reads the full
 * document (templates in parts, see `formatInsightTemplatePart`) and builds
 * section by section with no time limit.
 *
 * Server-only (it builds outlines with node-html-parser via chatOutline). The
 * client-safe pieces — the caps, the opening tag, the block parsers — live in
 * `templateAttachment.ts`.
 */
import { buildInsightChatOutline } from '@/lib/insights/chatOutline';
import {
  CHAT_INLINE_DOCUMENT_MAX_CHARS,
  TOO_LARGE_FOR_CHAT_STATUS,
  insightTemplateOpenTag,
  isTooLargeForChat,
} from '@/lib/insights/templateAttachment';

/** Cap on the outline that stands in for a too-large document, about 1.5k tokens. */
export const LARGE_DOCUMENT_OUTLINE_MAX_CHARS = 6_000;

/** A Workforce `get_insight_template` read returns the HTML in parts of at most this size. */
export const WORKFORCE_TEMPLATE_PART_CHARS = 60_000;

const TEMPLATE_OUTLINE_HINT =
  'The Workforce reads the full template with get_insight_template.';
const FILE_OUTLINE_HINT =
  'The full file travels with a Workforce handoff.';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function outlineOf(html: string, truncationHint: string): string {
  const { outline } = buildInsightChatOutline(html, {
    maxChars: LARGE_DOCUMENT_OUTLINE_MAX_CHARS,
    truncationHint,
  });
  return outline || '(no readable sections found)';
}

function tooLargeSentence(what: string, chars: number, verb = 'build'): string {
  return `${what} is ${fmt(chars)} characters — over the ${fmt(CHAT_INLINE_DOCUMENT_MAX_CHARS)} characters chat can write in one turn — so it is too large to ${verb} in chat. Its HTML is not included here, only an outline of its sections.`;
}

interface TemplateBlockInput {
  id: string;
  name: string;
  description?: string | null;
}

function attachedSentence(template: TemplateBlockInput, extra = ''): string {
  return `The user attached the insight template "${template.name}" (template_id ${template.id}${extra}) to this message.${template.description ? ` Description: ${template.description}` : ''}`;
}

/**
 * The hard instruction a chat turn gets for a template too large to build in
 * chat. Shared by the attached block and a chat `get_insight_template` read.
 */
export function largeTemplateHandoffInstruction(templateId: string): string[] {
  return [
    'Do this — it is a hard rule, not a suggestion:',
    `- Do NOT write the document yourself with any tool that writes a whole document. One tool call cannot carry a document this size inside the turn's time budget; the turn would time out with nothing to show.`,
    `- Call propose_workforce_handoff with the user's full request as the instruction, and put "template_id ${templateId}" in the instruction. The Workforce reads the whole template and builds the insight section by section, with no time limit.`,
    "- If the request doesn't say what the insight covers (which company, sector or fund), ask that one question first, then hand off.",
  ];
}

/**
 * The model-facing block for a template whose HTML was loaded, in chat.
 *
 * - Up to CHAT_INLINE_DOCUMENT_MAX_CHARS: the full HTML, and chat may build
 *   the insight itself.
 * - Larger: no HTML. An outline of its sections, its id and size, and the
 *   hard instruction to hand it to the Workforce.
 */
export function formatInsightTemplateBlock(template: TemplateBlockInput, html: string): string {
  if (isTooLargeForChat(html)) {
    return [
      insightTemplateOpenTag(template, TOO_LARGE_FOR_CHAT_STATUS),
      attachedSentence(template, `, ${fmt(html.length)} characters`),
      '',
      tooLargeSentence('This template', html.length),
      '',
      ...largeTemplateHandoffInstruction(template.id),
      '',
      '<template_outline>',
      outlineOf(html, TEMPLATE_OUTLINE_HINT),
      '</template_outline>',
      '</insight_template>',
    ].join('\n');
  }
  return [
    insightTemplateOpenTag(template),
    attachedSentence(template),
    '',
    'New insights are always built by the Workforce. To build the insight the user asks for on this template:',
    `- Call propose_workforce_handoff with the user's full request as the instruction, and put "template_id ${template.id}" in it. The Workforce keeps the template's layout, styling and data-section keys and replaces its sample content with real data.`,
    '- Every figure, name, date and table row in it is SAMPLE content — never quote one as a fact.',
    "- If the request doesn't say what the insight covers (which company, sector or fund), ask that one question first, then hand off.",
    `- To reuse this template on a later turn, reference template_id ${template.id}.`,
    '',
    '<template_html>',
    html,
    '</template_html>',
    '</insight_template>',
  ].join('\n');
}

/** How many Workforce parts a template of this size reads in. Never 0. */
export function templatePartCount(chars: number): number {
  return Math.max(1, Math.ceil(chars / WORKFORCE_TEMPLATE_PART_CHARS));
}

/**
 * One part of a template's full HTML, for a Workforce run. The HTML is cut
 * into consecutive parts of at most WORKFORCE_TEMPLATE_PART_CHARS; the header
 * says where this part sits and which part to read next. Part 1 also carries
 * the build rules. `part` is 1-based; one out of range returns a message
 * naming the valid range instead of HTML.
 */
export function formatInsightTemplatePart(
  template: TemplateBlockInput,
  html: string,
  part: number,
): string {
  const total = html.length;
  const count = templatePartCount(total);
  if (!Number.isInteger(part) || part < 1 || part > count) {
    return `Part ${part} is out of range: the insight template "${template.name}" (template_id ${template.id}) has ${count} ${count === 1 ? 'part' : 'parts'}. Call get_insight_template again with a part from 1 to ${count}.`;
  }
  const start = (part - 1) * WORKFORCE_TEMPLATE_PART_CHARS;
  const end = Math.min(part * WORKFORCE_TEMPLATE_PART_CHARS, total);
  const next =
    part < count
      ? `call again with part ${part + 1} until ${count}`
      : count === 1
        ? 'this is the whole template'
        : 'this is the last part — you now have the whole template';
  const lines = [
    insightTemplateOpenTag(template),
    `Insight template "${template.name}" (template_id ${template.id})${template.description ? ` — ${template.description}` : ''}: part ${part} of ${count}, chars ${fmt(start + 1)}–${fmt(end)} of ${fmt(total)}; ${next}.`,
  ];
  if (part === 1) {
    lines.push(
      '',
      'Build the insight on this template:',
      count > 1
        ? `- Read EVERY part (1 to ${count}) before you build anything: the template is only complete once you have them all.`
        : '- This one part is the complete template.',
      "- Build a kind: 'document' insight section by section: create_insight with a skeleton that keeps the template's styling, layout and data-section keys with each block emptied, then fill one block per turn with edit_insight_section.",
      '- Every figure, name, date and table row in it is SAMPLE content. Replace each with real data from the data tools, or mark it unknown — never carry a sample value into the insight.',
      `- Pass template_id ${template.id} to create_insight, so the insight records which template it came from.`,
    );
  }
  lines.push(
    '',
    `<template_html part="${part}" of="${count}">`,
    html.slice(start, end),
    '</template_html>',
    '</insight_template>',
  );
  return lines.join('\n');
}

/** An HTML file by extension (`.html`, `.htm`) or content type (`text/html`, with or without a charset). */
export function isHtmlAttachment(contentType: string, fileName: string): boolean {
  const ct = (contentType || '').toLowerCase().trim();
  const name = fileName.toLowerCase();
  return ct.startsWith('text/html') || name.endsWith('.html') || name.endsWith('.htm');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The block for an HTML file attached in chat that is too large to inline:
 * an outline plus the hard handoff instruction. It keeps the `Attached file
 * "<name>":` prefix every attachment block has, so the chat history hides it
 * from the user's bubble the same way.
 */
export function formatLargeHtmlAttachmentBlock(fileName: string, html: string): string {
  return [
    `Attached file "${fileName}":`,
    '',
    `<large_document file="${escapeAttr(fileName)}" chars="${html.length}" status="${TOO_LARGE_FOR_CHAT_STATUS}">`,
    tooLargeSentence(`This HTML file`, html.length),
    '',
    'To build an insight, a template or any other document from this file — a hard rule, not a suggestion:',
    '- Do NOT write the document yourself with any tool that writes a whole document from it. One tool call cannot carry a document this size inside the turn\'s time budget; the turn would time out with nothing to show.',
    `- Call propose_workforce_handoff with the user's full request as the instruction, and refer to the attached file "${fileName}" by name. The file travels with the handoff: the Workforce receives it in full and builds the document section by section, with no time limit.`,
    '- For a quick question about the file, you may answer from this outline — say that you read only its outline.',
    `- To EMAIL this file, no handoff is needed: call send_email with attached_html.file_name "${escapeAttr(fileName)}". It reads the stored file, reformats it for email and sends it as the body, so the outline below is irrelevant — never retype the document into the email body.`,
    '',
    '<document_outline>',
    outlineOf(html, FILE_OUTLINE_HINT),
    '</document_outline>',
    '</large_document>',
  ].join('\n');
}

const INSIGHT_OUTLINE_HINT =
  'The Workforce reads the full insight with get_insight.';

/**
 * The instruction a chat turn gets for an insight too large to edit whole in
 * chat. `propose_insight_edit` without a `section` carries the whole
 * document, so one edit of a document this size cannot be written inside a
 * chat turn's budget — but an edit confined to one data-section block
 * travels as that block alone, whatever the document's size, so it stays in
 * chat. Only a change wider than one block goes to the Workforce.
 */
export function largeInsightEditHandoffInstruction(insightId: string): string[] {
  return [
    'To change this insight — a hard rule, not a suggestion:',
    `- Do NOT call propose_insight_edit WITHOUT a \`section\` (or any other tool that writes a whole document) for it. One tool call cannot carry a document this size inside the turn's time budget; the turn would time out with nothing to show.`,
    `- If the change is confined to ONE data-section block — the block the user selected (read_page_context), or the one the request plainly concerns in the outline below — edit it in chat by section: call get_insight with section: "<key>" to read just that block, then propose_insight_edit with the same section and ONLY the block's complete replacement fragment as html. The document never passes through you; the server splices the fragment in.`,
    `- If the change spans several blocks or restructures the document, call propose_workforce_handoff with the user's full requested change as the instruction. Put "insight_id ${insightId}" in the instruction, and copy the selected section key or element path from the user's message (or read_page_context) into it verbatim, so the Workforce changes exactly that part. The Workforce reads the whole document and applies the edit directly as a new version; the previous version stays in the insight's history and can be restored.`,
    '- For a question about the insight, answer from this outline — say that you read only its outline.',
  ];
}

interface LargeInsightInput {
  id: string;
  name: string;
  html: string;
}

/**
 * What a chat `get_insight` read returns for an insight over
 * CHAT_INLINE_DOCUMENT_MAX_CHARS: its size, an outline of its sections and
 * the instruction to edit it one section at a time, or to hand a wider edit
 * to the Workforce — never its HTML. The caller writes the header lines
 * (name, id, version, kind) above it.
 */
export function formatLargeInsightForChat(insight: LargeInsightInput): string {
  return [
    tooLargeSentence('This insight', insight.html.length, 'edit whole'),
    '',
    ...largeInsightEditHandoffInstruction(insight.id),
    '',
    '<insight_outline>',
    outlineOf(insight.html, INSIGHT_OUTLINE_HINT),
    '</insight_outline>',
  ].join('\n');
}

interface LargeInsightSectionInput {
  id: string;
  section: string;
  html: string;
}

/**
 * What a chat `get_insight` read of one section returns when that section
 * alone is over CHAT_INLINE_DOCUMENT_MAX_CHARS: a section edit still has to
 * write the whole block back, so a block this size cannot be rewritten in a
 * chat turn either. An outline of the block and the handoff instruction.
 */
export function formatLargeInsightSectionForChat(input: LargeInsightSectionInput): string {
  return [
    `Section "${input.section}" alone is ${fmt(input.html.length)} characters — over the ${fmt(CHAT_INLINE_DOCUMENT_MAX_CHARS)} characters chat can write in one turn — so even this one block is too large to rewrite in chat. Its HTML is not included here, only an outline.`,
    '',
    'To change it — a hard rule, not a suggestion:',
    `- Do NOT call propose_insight_edit for it, with or without a \`section\`. One tool call cannot carry a block this size inside the turn's time budget; the turn would time out with nothing to show.`,
    `- Call propose_workforce_handoff with the user's full requested change as the instruction. Put "insight_id ${input.id}" and "section ${input.section}" in the instruction, so the Workforce changes exactly that block. It applies the edit directly as a new version; the previous version stays in the insight's history and can be restored.`,
    '- For a question about this block, answer from this outline — say that you read only its outline.',
    '',
    '<insight_section_outline>',
    outlineOf(input.html, INSIGHT_OUTLINE_HINT),
    '</insight_section_outline>',
  ].join('\n');
}
