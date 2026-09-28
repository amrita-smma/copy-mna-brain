export const INSIGHT_TEMPLATE_ICONS = [
  'chart-line',
  'briefcase',
  'scale',
  'file-text',
  'globe',
  'building',
  'shield',
  'pie-chart',
] as const;

export type InsightTemplateIcon = (typeof INSIGHT_TEMPLATE_ICONS)[number];

export function isInsightTemplateIcon(v: unknown): v is InsightTemplateIcon {
  return typeof v === 'string' && (INSIGHT_TEMPLATE_ICONS as readonly string[]).includes(v);
}
