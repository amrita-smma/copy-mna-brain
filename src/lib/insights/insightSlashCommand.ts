import type { InsightTemplateSummary } from '@/lib/api/insightTemplates';
import type { SlashCommandDefinition } from '@/lib/chat/slashCommand';

/** Leading-token-only trigger that opens the insight-template popup in Copilot. */
export const INSIGHT_TEMPLATE_TRIGGER = '/insight-template';

/** This command's entry in the composer's slash-command palette. */
export const INSIGHT_TEMPLATE_COMMAND: SlashCommandDefinition = {
  trigger: INSIGHT_TEMPLATE_TRIGGER,
  label: 'Create an insight from a template',
};

/** Case-insensitive substring match on template name; empty query -> full list. */
export function filterInsightTemplates(
  templates: InsightTemplateSummary[],
  query: string,
): InsightTemplateSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter((t) => t.name.toLowerCase().includes(q));
}

/**
 * Moves the most-recently-used template to the front of the list so it
 * surfaces first when the popup opens with an empty query. A no-op when
 * `lastUsedId` is null, already first, or no longer present in `templates`
 * (e.g. the template was deleted since).
 */
export function sortTemplatesByRecency(
  templates: InsightTemplateSummary[],
  lastUsedId: string | null,
): InsightTemplateSummary[] {
  if (!lastUsedId) return templates;
  const idx = templates.findIndex((t) => t.id === lastUsedId);
  if (idx <= 0) return templates;
  const copy = templates.slice();
  const [match] = copy.splice(idx, 1);
  copy.unshift(match);
  return copy;
}
