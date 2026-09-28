import { isUuid } from '@/lib/uuid';

/**
 * An insight template attached to a chat message. It travels as a structured
 * `data-insight-template` UI message part (never as text in the user's words),
 * and the server expands it into an `<insight_template>` content block on the
 * model-facing human turn. Shared by client and server — no server imports.
 */
export const INSIGHT_TEMPLATE_PART_TYPE = 'data-insight-template';

/**
 * The hard cap on a template's HTML in the library, in characters
 * (`html.length`): upload, replace, save-as-template, duplicate and restore.
 * A 250k body stays far under Vercel's 4.5 MB request limit. A template this
 * large is never inlined into a chat turn — see CHAT_INLINE_DOCUMENT_MAX_CHARS.
 */
export const INSIGHT_TEMPLATE_MAX_CHARS = 250_000;

/**
 * The largest document chat may inline in full or write in one tool call.
 * Why 20k: that is roughly what a single model call can write inside the
 * `medium` tier's 180 s turn budget, thinking included. Anything larger goes
 * to the Workforce, which builds it section by section with no time limit.
 */
export const CHAT_INLINE_DOCUMENT_MAX_CHARS = 20_000;

/** True when a document is too large for chat to inline or write in one call. */
export function isTooLargeForChat(text: string): boolean {
  return text.length > CHAT_INLINE_DOCUMENT_MAX_CHARS;
}

/**
 * The `status` attribute on an `<insight_template>` block that carries an
 * outline instead of the template's HTML, because the template is too large
 * for chat. Written only by the server, at the very start of the block.
 */
export const TOO_LARGE_FOR_CHAT_STATUS = 'too-large-for-chat';

/** "Template is 285,000 characters; templates are limited to 250,000." */
export function formatTemplateTooLargeMessage(chars: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return `Template is ${fmt(chars)} characters; templates are limited to ${fmt(INSIGHT_TEMPLATE_MAX_CHARS)}.`;
}

const MAX_NAME_LENGTH = 200;
const BLOCK_OPEN_RE = /^<insight_template id="([^"]*)" name="([^"]*)"/;
const TOO_LARGE_BLOCK_RE = new RegExp(
  `^<insight_template id="[^"]*" name="[^"]*" status="${TOO_LARGE_FOR_CHAT_STATUS}"`,
);

export interface InsightTemplateAttachment {
  id: string;
  name: string;
}

function asAttachment(data: unknown): InsightTemplateAttachment | null {
  if (!data || typeof data !== 'object') return null;
  const { id, name } = data as { id?: unknown; name?: unknown };
  if (typeof id !== 'string' || !isUuid(id)) return null;
  const trimmed = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LENGTH) : '';
  return { id, name: trimmed || 'Insight template' };
}

/** The template attached to a UI message's parts, or null. Browser-supplied, so validated. */
export function readInsightTemplatePart(parts: unknown): InsightTemplateAttachment | null {
  if (!Array.isArray(parts)) return null;
  const part = parts.find(
    (p) => p && typeof p === 'object' && (p as { type?: unknown }).type === INSIGHT_TEMPLATE_PART_TYPE,
  ) as { data?: unknown } | undefined;
  return part ? asAttachment(part.data) : null;
}

export function insightTemplatePart(attachment: InsightTemplateAttachment) {
  return { type: INSIGHT_TEMPLATE_PART_TYPE, data: attachment } as const;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The opening tag of an `<insight_template>` block. `parseInsightTemplateBlock`
 * and the chat history both key on this exact shape, so every block starts
 * with it. The block bodies are built server-side (`templateBlock.ts`).
 */
export function insightTemplateOpenTag(
  template: { id: string; name: string },
  status?: string,
): string {
  const statusAttr = status ? ` status="${escapeAttr(status)}"` : '';
  return `<insight_template id="${escapeAttr(template.id)}" name="${escapeAttr(template.name)}"${statusAttr}>`;
}

/** The model-facing block for an attached template that could not be loaded. */
export function formatMissingInsightTemplateBlock(attachment: InsightTemplateAttachment): string {
  return [
    insightTemplateOpenTag(attachment, 'missing'),
    `The user attached the insight template "${attachment.name}", but it could not be loaded — it may have been deleted. Tell the user, and ask which template to use instead.`,
    '</insight_template>',
  ].join('\n');
}

/** Reverses a stored block back into its attachment, for re-rendering history. */
export function parseInsightTemplateBlock(text: string): InsightTemplateAttachment | null {
  const match = BLOCK_OPEN_RE.exec(text);
  if (!match) return null;
  return asAttachment({ id: unescapeAttr(match[1]), name: unescapeAttr(match[2]) });
}

/** True for a block that carries an outline because the template is too large for chat. */
export function isTooLargeInsightTemplateBlock(text: string): boolean {
  return TOO_LARGE_BLOCK_RE.test(text);
}
