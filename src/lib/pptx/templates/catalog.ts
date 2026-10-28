/**
 * The PowerPoint templates a workspace can pick from the admin portal.
 *
 * Client-safe: ids and labels only. The template definitions themselves (the
 * slide master and its brand images) live in `@/lib/pptx/templates` and read
 * files off disk, so they are server-only.
 */

export const PPTX_TEMPLATE_IDS = ['default', 'starcapital'] as const;

export type PptxTemplateId = (typeof PPTX_TEMPLATE_IDS)[number];

export const DEFAULT_PPTX_TEMPLATE: PptxTemplateId = 'default';

export const PPTX_TEMPLATE_LABELS: Record<PptxTemplateId, string> = {
  default: 'Default',
  starcapital: 'StarCapital',
};

export function isPptxTemplateId(value: unknown): value is PptxTemplateId {
  return typeof value === 'string' && (PPTX_TEMPLATE_IDS as readonly string[]).includes(value);
}

/** Unknown or unset values read back as the default template. */
export function normalizePptxTemplate(value: unknown): PptxTemplateId {
  return isPptxTemplateId(value) ? value : DEFAULT_PPTX_TEMPLATE;
}
