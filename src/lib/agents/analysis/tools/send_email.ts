import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { UserRepository } from '@/lib/repositories';
import { EmailService } from '@/lib/services/emailService';
import type { EmailAttachment } from '@/lib/ses';
import {
  companyExcelSpecSchema,
  researchSummarySpecSchema,
  buildCompanyExcelAttachment,
  buildResearchSummaryAttachment,
} from './emailArtifacts';

/**
 * send_email — send ONE agent-composed email to one or more platform users.
 *
 * The email always carries a free-form subject + body, and may additionally
 * carry, in the SAME message:
 *   - a comprehensive company Excel workbook (`company_excel`), and/or
 *   - a formatted research-summary PDF (`research_summary`).
 *
 * This is the single send path for everything the agent assembles: instead of
 * firing a separate email for the spreadsheet, another for the PDF, and a third
 * for the note, it composes the pieces and delivers them together as one email.
 *
 * Recipients: default to the signed-in user (resolved from runtime config,
 * never agent text) when `to` is omitted. Any `to` addresses are STRICTLY
 * limited to registered platform users (the `users` table) — non-platform
 * addresses are silently skipped and reported, so this tool cannot be coerced
 * into mailing arbitrary third parties (exfiltration / spam guardrail).
 *
 * Available to both the copilot chat and the workforce agent.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AllowedRecipient {
  email: string;
  name: string;
}

const argsSchema = z.object({
  to: z
    .array(z.string())
    .optional()
    .describe(
      'Recipient email addresses — each must be a registered platform user. Omit to send to the signed-in user.',
    ),
  subject: z.string().min(1).max(200).describe('Email subject line.'),
  body: z.string().min(1).max(5000).describe('Plain-text email body (newlines preserved).'),
  company_excel: companyExcelSpecSchema
    .optional()
    .describe(
      'Optional: attach a comprehensive multi-sheet company Excel (.xlsx) built from these filters. Omit if no spreadsheet is wanted.',
    ),
  research_summary: researchSummarySpecSchema
    .optional()
    .describe(
      'Optional: attach a formatted research-summary PDF built from these sections. Omit if no PDF is wanted.',
    ),
});

type Args = z.infer<typeof argsSchema>;

function extractUserEmailFromConfig(config: RunnableConfig | undefined): string | null {
  const value = config?.configurable?.userEmail;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export const sendEmailTool = tool(
  async (args: Args, runtime?: RunnableConfig) => {
    logger.debug(
      `🔧 TOOL CALLED: send_email(to=[${(args.to ?? []).join(', ')}], subject='${args.subject ?? ''}', excel=${Boolean(
        args.company_excel,
      )}, pdf=${Boolean(args.research_summary)})`,
    );

    const subject = args.subject?.trim();
    const body = args.body?.trim();
    if (!subject) return '**Error:** subject is required.';
    if (!body) return '**Error:** body is required.';

    try {
      const db = createDb();
      const userRepo = new UserRepository(db);
      const users = await userRepo.findAll();

      // Build the whitelist: only registered platform users with an email.
      const allowed = new Map<string, AllowedRecipient>();
      for (const u of users) {
        const email = u.email?.trim();
        if (email) allowed.set(email.toLowerCase(), { email, name: u.name });
      }

      // ── Resolve recipients: explicit `to` (whitelisted) or the signed-in user. ──
      const recipients: AllowedRecipient[] = [];
      const rejected: string[] = [];
      const requested = Array.from(
        new Set((args.to ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
      );

      if (requested.length > 0) {
        const malformed = requested.filter((e) => !EMAIL_RE.test(e));
        if (malformed.length > 0) {
          return `**Error:** malformed email address(es): ${malformed.join(', ')}.`;
        }
        for (const e of requested) {
          const match = allowed.get(e);
          if (match) recipients.push(match);
          else rejected.push(e);
        }
        if (recipients.length === 0) {
          return `**Error:** none of the requested recipients are registered platform users, so nothing was sent. Emails can only be sent to users that exist on the platform. Rejected: ${rejected.join(', ')}.`;
        }
      } else {
        // Default: the signed-in user from runtime config.
        const signedIn = extractUserEmailFromConfig(runtime);
        if (!signedIn) {
          return '**Error:** No recipients given and no signed-in user email is available on the runtime.';
        }
        if (!EMAIL_RE.test(signedIn)) {
          logger.error(`send_email: malformed userEmail in config: ${signedIn}`);
          return '**Error:** The signed-in user email on file is malformed; cannot send.';
        }
        const match = allowed.get(signedIn.toLowerCase());
        recipients.push(match ?? { email: signedIn, name: '' });
      }

      // ── Build attachments (shared by every recipient). ──
      const attachments: EmailAttachment[] = [];
      const attachmentLabels: string[] = [];
      const notes: string[] = [];

      if (args.research_summary) {
        const artifact = await buildResearchSummaryAttachment(
          args.research_summary,
          recipients.length === 1 ? recipients[0].email : undefined,
        );
        attachments.push(artifact.attachment);
        attachmentLabels.push('research summary (PDF)');
      }

      if (args.company_excel) {
        const artifact = await buildCompanyExcelAttachment(args.company_excel);
        if (artifact) {
          attachments.push(artifact.attachment);
          attachmentLabels.push(
            `company Excel (${artifact.companyCount} compan${artifact.companyCount === 1 ? 'y' : 'ies'})`,
          );
        } else {
          notes.push(
            'No companies matched the Excel filter, so the spreadsheet was not attached.',
          );
        }
      }

      // ── Send ONE composed email per recipient. ──
      const emailService = new EmailService();
      const sent: string[] = [];
      const failed: string[] = [];
      for (const r of recipients) {
        try {
          const { messageId } = await emailService.sendComposedEmail({
            email: r.email,
            subject,
            body,
            attachments,
          });
          sent.push(r.email);
          logger.info(
            `📧 send_email → ${r.email} (${attachments.length} attachment(s), messageId=${messageId || 'n/a'})`,
          );
        } catch (err) {
          failed.push(r.email);
          logger.error(`send_email to ${r.email} failed: ${(err as Error).message}`);
        }
      }

      const parts: string[] = [];
      if (sent.length > 0) {
        const withPart =
          attachmentLabels.length > 0 ? ` with ${attachmentLabels.join(' + ')}` : '';
        parts.push(`Sent to ${sent.length} platform user(s)${withPart}: ${sent.join(', ')}.`);
      }
      if (notes.length > 0) parts.push(notes.join(' '));
      if (rejected.length > 0) {
        parts.push(
          `Skipped ${rejected.length} address(es) not on the platform: ${rejected.join(', ')}.`,
        );
      }
      if (failed.length > 0) {
        parts.push(`Failed to send to: ${failed.join(', ')}.`);
      }

      if (sent.length === 0) {
        return `**Error:** ${parts.join(' ')}`;
      }
      return parts.join(' ');
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`send_email failed: ${message}`);
      return `**Error:** Could not send email — ${message}`;
    }
  },
  {
    name: 'send_email',
    description: `Send ONE email to one or more platform users. You compose the subject and body; you may also attach a company spreadsheet and/or a research PDF — everything goes in a SINGLE email, never split across multiple messages.

IMPORTANT — recipients are restricted to a whitelist: only addresses that belong to a registered platform user (the users table) can be emailed. Omit \`to\` to send to the signed-in user (resolved by the runtime — you do NOT need their address). Any \`to\` address that is not a known platform user is silently skipped and reported back; the email is never delivered to non-platform addresses. Do NOT use this tool to email customers, bankers, or external parties.

VOICE — always write and sign on behalf of the app, "Investment Brain", NOT the human user. Do NOT sign off with an individual person's name. If you include a signature, sign as "Investment Brain".

## Attachments (both optional — include only what the user asked for)

- \`company_excel\` — attach a comprehensive multi-sheet Excel (.xlsx) export of filtered companies (profile + resolved sponsor/captain/enterer names + latest-year financials + AI Opinion, plus "Financials by Year", "Screening", and "FX Adjustments" sheets). Pass any combination of query_companies-style filters (segment, geography, watchlist_status, stage, name, ownership, company_focus, source, status, deal_type, deal_sponsor, banker, has_ai_opinion, ai_opinion_verdict, min_revenue, max_revenue, min_ebitda, max_ebitda, created_after, created_before, search_term) plus an optional \`title\`. Omit all filters to export the entire pipeline. If the filter matches no companies, the spreadsheet is skipped (the email still sends).

- \`research_summary\` — attach a formatted PDF built from an ordered \`sections\` array. Each entry is one of:
  - \`heading\` { text, level?: "section" | "subsection" }
  - \`paragraph\` { text }
  - \`bullets\` { items }
  - \`kpi_cards\` { cards: [{ label, value, hint? }] }
  - \`bar_chart\` { title?, unit?, data: [{ year, value }], accent?: "primary" | "secondary" }
  - \`gauges\` { gauges: [{ label, valuePct, tone?, trendLabel? }] }
  - \`scorecard\` { rows: [{ label, pill: { label, tone }, rationale }], columns?, overallPill?, overallNote? }
  - \`quadrants\` { quadrants: { topLeft, topRight, bottomLeft, bottomRight, xLabelLow?, xLabelHigh?, yLabelHigh?, yLabelLow? } }
  - \`priority_list\` { items: [{ priority: { label, tone: "high" | "medium" | "low" }, description, meta? }] }
  Pick the visual block whenever the data suits one; fall back to \`paragraph\` / \`bullets\` for narrative. Also pass a \`title\` (used for the PDF + filename) and optional \`references\`. Rules: keep one unit per bar_chart series; no markdown inside block strings; keep KPI \`value\` to one short line.

## Usage

- Plain note to a colleague → just \`to\` + \`subject\` + \`body\`.
- "Email me the pipeline as a spreadsheet" → \`body\` + \`company_excel\` (omit \`to\`).
- "Email me a summary and the L1 companies" → \`body\` + \`research_summary\` + \`company_excel\` — ONE email, both attached.

After the tool returns, write ONE short sentence confirming, or surface its **Error:** verbatim.

Args:
    to: Optional. Recipient email addresses (each a registered platform user). Omit to send to the signed-in user.
    subject: Required. The email subject line.
    body: Required. Plain-text body (Markdown is NOT rendered). Sign off as "Investment Brain".
    company_excel: Optional. Filters (+ title) for an attached Excel workbook.
    research_summary: Optional. Title + sections (+ references) for an attached PDF.

Returns:
    A confirmation string listing recipients, what was attached, and any skipped addresses, or an error string starting with **Error:**.`,
    schema: argsSchema,
  },
);
