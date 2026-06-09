import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import {
  generateResearchSummaryPdf,
  type ResearchSummaryPdfInput,
  type SectionBlock,
  type KpiInput,
  type YearValueInput,
  type GaugeInput,
  type ScorecardRowInput,
  type PriorityItemInput,
  type QuadrantsInput,
  type PillInput,
  type PillTone,
} from '@/lib/pdfSummary';
import { EmailService } from '@/lib/services/emailService';

// ---- Pill / shared primitive schemas ----

const pillSchema = z.object({
  label: z.string().describe('Short pill text, e.g. "PASS", "STRENGTH", "URGENT", "POSITIVE", "INFO"'),
  tone: z
    .enum(['positive', 'negative', 'neutral', 'warning', 'info'])
    .describe(
      'Pill color: positive=green, negative=red, warning=amber, info=blue, neutral=gray',
    ),
});

const kpiSchema = z.object({
  label: z.string().describe('Short uppercase-able card label'),
  value: z.string().describe('Single-line headline value'),
  hint: z.string().optional().describe('Optional one-line context under the value'),
});

const yearValueSchema = z.object({
  year: z.string().describe('X-axis label, e.g. "FY2024", "2024 Q1", "Mar"'),
  value: z.number().describe('Numeric value for the bar height'),
});

const gaugeSchema = z.object({
  label: z.string().describe('Gauge label, e.g. "EBITDA margin", "Sentiment", "Approval %"'),
  valuePct: z.number().describe('Fill percentage 0–100'),
  tone: z
    .enum(['positive', 'negative', 'neutral'])
    .optional()
    .describe('Bar fill color: positive=green, negative=red, neutral=gray'),
  trendLabel: z
    .string()
    .optional()
    .describe('Optional inline label after the value, e.g. "rising", "vs Q4: +3pp"'),
});

const scorecardRowSchema = z.object({
  label: z.string().describe('Row label, e.g. a criterion, a player, a metric'),
  pill: pillSchema,
  rationale: z.string().describe('One-sentence note rendered in the rationale column'),
});

const priorityItemSchema = z.object({
  priority: z.object({
    label: z.string().describe('Short tag shown in the colored pill, e.g. "P1", "URGENT", "WATCH"'),
    tone: z.enum(['high', 'medium', 'low']).describe('Pill color: high=red, medium=amber, low=blue'),
  }),
  description: z.string().describe('Bolded action / item line'),
  meta: z
    .string()
    .optional()
    .describe('Optional muted meta line below the description, e.g. "Owner: Workforce - Due: this week"'),
});

const quadrantsSchema = z.object({
  topLeft: z.array(z.string()).default([]),
  topRight: z.array(z.string()).default([]),
  bottomLeft: z.array(z.string()).default([]),
  bottomRight: z.array(z.string()).default([]),
  xLabelLow: z.string().optional().describe('X-axis label rendered above the left column'),
  xLabelHigh: z.string().optional().describe('X-axis label rendered above the right column'),
  yLabelHigh: z.string().optional().describe('Y-axis label rendered next to the top row'),
  yLabelLow: z.string().optional().describe('Y-axis label rendered next to the bottom row'),
});

// ---- Section block discriminated union ----

const sectionBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    level: z.enum(['section', 'subsection']).optional(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('paragraph'), text: z.string() }),
  z.object({ kind: z.literal('bullets'), items: z.array(z.string()) }),
  z.object({ kind: z.literal('kpi_cards'), cards: z.array(kpiSchema).min(1).max(12) }),
  z.object({
    kind: z.literal('bar_chart'),
    title: z.string().optional(),
    unit: z.string().optional(),
    data: z.array(yearValueSchema).min(1).max(12),
    accent: z.enum(['primary', 'secondary']).optional(),
  }),
  z.object({ kind: z.literal('gauges'), gauges: z.array(gaugeSchema).min(1).max(8) }),
  z.object({
    kind: z.literal('scorecard'),
    rows: z.array(scorecardRowSchema).min(1),
    overallPill: pillSchema.optional(),
    overallNote: z.string().optional(),
    columns: z
      .object({
        label: z.string().optional(),
        verdict: z.string().optional(),
        rationale: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('quadrants'), quadrants: quadrantsSchema }),
  z.object({ kind: z.literal('priority_list'), items: z.array(priorityItemSchema).min(1) }),
]);

const referenceSchema = z.object({
  name: z.string(),
  link: z.string().optional(),
  date: z.string().optional(),
});

const argsSchema = z.object({
  title: z.string().describe('Document title (used for the PDF, the email subject prefix, and the filename slug).'),
  sections: z
    .array(sectionBlockSchema)
    .min(1)
    .describe('Ordered list of rendered blocks. Compose freely; no required structure.'),
  subject: z.string().optional().describe('Optional email subject override.'),
  references: z.array(referenceSchema).optional().describe('Optional source list rendered at the end.'),
});

type Args = z.infer<typeof argsSchema>;

// ---- Mapping zod-inferred -> renderer types ----

function mapSection(s: Args['sections'][number]): SectionBlock {
  switch (s.kind) {
    case 'heading':
      return { kind: 'heading', level: s.level, text: s.text };
    case 'paragraph':
      return { kind: 'paragraph', text: s.text };
    case 'bullets':
      return { kind: 'bullets', items: s.items };
    case 'kpi_cards':
      return { kind: 'kpi_cards', cards: s.cards as KpiInput[] };
    case 'bar_chart':
      return {
        kind: 'bar_chart',
        title: s.title,
        unit: s.unit,
        data: s.data as YearValueInput[],
        accent: s.accent,
      };
    case 'gauges':
      return { kind: 'gauges', gauges: s.gauges as GaugeInput[] };
    case 'scorecard':
      return {
        kind: 'scorecard',
        rows: s.rows as ScorecardRowInput[],
        overallPill: s.overallPill as PillInput | undefined,
        overallNote: s.overallNote,
        columns: s.columns,
      };
    case 'quadrants':
      return { kind: 'quadrants', quadrants: s.quadrants as QuadrantsInput };
    case 'priority_list':
      return { kind: 'priority_list', items: s.items as PriorityItemInput[] };
  }
}

function previewFromSections(sections: Args['sections']): string {
  for (const s of sections) {
    if (s.kind === 'paragraph') return s.text;
    if (s.kind === 'bullets' && s.items.length > 0) {
      return s.items.slice(0, 2).join(' - ');
    }
  }
  return '';
}

// ---- Config helpers ----

/**
 * Extract the signed-in user's email from the langchain RunnableConfig that
 * the chat route attaches via `configurable: { userEmail }`. The agent never
 * sees this value — it's threaded through runtime config so emails are a
 * parameter, not LLM-parsed text.
 */
function extractUserEmailFromConfig(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.userEmail;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// ---- Tool ----

/**
 * Email a research-summary PDF to the signed-in user.
 *
 * The recipient is determined by `config.configurable.userEmail` (passed by
 * the chat route) — the agent never names a recipient, so this tool cannot
 * be coerced into sending to a third party.
 *
 * The PDF is rendered from a flexible list of section blocks. The agent
 * composes whichever blocks fit the document at hand; the renderer dispatches
 * on `kind` for each entry in `sections` and draws purpose-built visuals
 * (KPI cards, bar charts, gauges, scorecard tables, 2x2 matrices, priority
 * pills).
 */
export const emailResearchSummary = tool(
  async (args: Args, runtime?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: email_research_summary(title='${args.title}')`);

    const recipient = extractUserEmailFromConfig(runtime);
    if (!recipient) {
      return '**Error:** No signed-in user email is available on the runtime. Ask the user to add an email to their profile or sign in with an account that has one.';
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      logger.error(`email_research_summary: malformed userEmail in config: ${recipient}`);
      return '**Error:** The signed-in user email on file is malformed; cannot send.';
    }
    if (!args.title || args.title.trim().length === 0) {
      return '**Error:** title is required.';
    }
    if (!args.sections || args.sections.length === 0) {
      return '**Error:** sections is required and must contain at least one block.';
    }

    try {
      const subtitle = `Prepared for ${recipient} - ${new Date().toISOString().slice(0, 10)}`;
      const pdfInput: ResearchSummaryPdfInput = {
        title: args.title,
        subtitle,
        sections: args.sections.map(mapSection),
        references: args.references?.map((r) => ({
          name: r.name,
          link: r.link ?? null,
          date: r.date ?? null,
        })),
      };

      const pdfBuffer = await generateResearchSummaryPdf(pdfInput);
      const preview = previewFromSections(args.sections) || `Summary: ${args.title}`;

      const emailService = new EmailService();
      const { messageId } = await emailService.sendResearchSummaryEmail({
        email: recipient,
        title: args.title,
        summaryMarkdown: preview,
        pdfBuffer,
        subject: args.subject,
      });

      logger.info(
        `📧 Research summary emailed to ${recipient} (messageId=${messageId})`,
      );
      return `Emailed the research summary PDF to your inbox. (SES message id: ${messageId || 'n/a'})`;
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`email_research_summary failed: ${message}`);
      return `**Error:** Could not send email — ${message}`;
    }
  },
  {
    name: 'email_research_summary',
    description: `Email the signed-in user a PDF of any research write-up. Recipient is resolved by the runtime — you do NOT pass an email.

Compose the document as an ordered \`sections\` array. Each entry is one of:
- \`heading\` { text, level?: "section" | "subsection" } — divider above the next block.
- \`paragraph\` { text } — wrapped prose.
- \`bullets\` { items } — bulleted list.
- \`kpi_cards\` { cards: [{ label, value, hint? }] } — 3-up bordered cards.
- \`bar_chart\` { title?, unit?, data: [{ year, value }], accent?: "primary" | "secondary" } — fiscal-year bar chart.
- \`gauges\` { gauges: [{ label, valuePct, tone?, trendLabel? }] } — horizontal percent bars (tone: positive/negative/neutral).
- \`scorecard\` { rows: [{ label, pill: { label, tone }, rationale }], columns?, overallPill?, overallNote? } — table with colored badge per row (tones: positive/negative/neutral/warning/info).
- \`quadrants\` { quadrants: { topLeft, topRight, bottomLeft, bottomRight, xLabelLow?, xLabelHigh?, yLabelHigh?, yLabelLow? } } — generic 2x2 matrix. Axis labels are caller-defined (works for risk, SWOT, severity×urgency, etc.).
- \`priority_list\` { items: [{ priority: { label, tone: "high" | "medium" | "low" }, description, meta? }] } — colored priority pill rows.

Pick the visual block whenever the data suits one — \`kpi_cards\` for KPIs, \`bar_chart\` for time series, \`scorecard\` for rated items, \`quadrants\` for 2x2 framings, \`priority_list\` for ranked actions. Fall back to \`paragraph\` / \`bullets\` only for narrative the visuals can't carry.

## Examples

### Example 1 — M&A target eval (exercises most blocks)
\`\`\`json
{
  "title": "Acme Corp research summary",
  "sections": [
    { "kind": "heading", "text": "Executive Summary" },
    { "kind": "bullets", "items": ["Revenue +30% YoY in FY2024", "EBITDA margin 24% and rising", "Ownership family-controlled"] },
    { "kind": "kpi_cards", "cards": [
      { "label": "Revenue (FY24)", "value": "$112M", "hint": "+22% YoY" },
      { "label": "EBITDA margin", "value": "24%" }
    ]},
    { "kind": "bar_chart", "title": "Revenue", "unit": "USD millions", "data": [
      { "year": "FY22", "value": 74 }, { "year": "FY23", "value": 92 }, { "year": "FY24", "value": 112 }
    ]},
    { "kind": "scorecard", "rows": [
      { "label": "Revenue >= $50M", "pill": { "label": "PASS", "tone": "positive" }, "rationale": "$112M FY24" },
      { "label": "Sponsorable ownership", "pill": { "label": "FAIL", "tone": "negative" }, "rationale": "Family-controlled" }
    ], "overallPill": { "label": "PARTIAL", "tone": "warning" } },
    { "kind": "quadrants", "quadrants": {
      "topLeft": ["Regulatory exposure"], "topRight": ["Customer concentration"],
      "bottomLeft": [], "bottomRight": ["FX exposure"],
      "xLabelLow": "Low likelihood", "xLabelHigh": "High likelihood",
      "yLabelHigh": "High impact", "yLabelLow": "Low impact"
    }},
    { "kind": "priority_list", "items": [
      { "priority": { "label": "P1", "tone": "high" }, "description": "Refresh financial diligence", "meta": "Owner: Workforce - this week" }
    ]}
  ]
}
\`\`\`

### Example 2 — SWOT (custom quadrant axis labels)
\`\`\`json
{
  "title": "SWOT - Beta Corp",
  "sections": [
    { "kind": "quadrants", "quadrants": {
      "topLeft": ["Strong gross margin"], "topRight": ["Heavy customer concentration"],
      "bottomLeft": ["Adjacent market expanding 18%/yr"], "bottomRight": ["Looming export controls"],
      "xLabelLow": "Positive", "xLabelHigh": "Negative",
      "yLabelHigh": "Internal", "yLabelLow": "External"
    }}
  ]
}
\`\`\`

### Example 3 — Daily market update (no charts, just KPI + bullets + priorities)
\`\`\`json
{
  "title": "Daily market update - 2025-06-08",
  "sections": [
    { "kind": "kpi_cards", "cards": [
      { "label": "S&P 500", "value": "5,432", "hint": "+0.4%" },
      { "label": "KOSPI", "value": "2,684", "hint": "-0.2%" }
    ]},
    { "kind": "heading", "text": "Top stories" },
    { "kind": "bullets", "items": ["Story 1", "Story 2"] },
    { "kind": "priority_list", "items": [
      { "priority": { "label": "WATCH", "tone": "high" }, "description": "Earnings from key APAC names this week" }
    ]}
  ]
}
\`\`\`

## Rules

- Use the SAME unit across one \`bar_chart\` series.
- Don't put markdown (\`**bold**\` etc.) inside block strings — it renders literally.
- Keep KPI \`value\` to one short line; put context in \`hint\`.

Returns: a confirmation string with the SES message id, or an error string starting with **Error:**.`,
    schema: argsSchema,
  },
);

// Re-export the pill tone type to keep tool consumers strongly typed.
export type { PillTone };
