import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { UserRepository } from '@/lib/repositories';
import { EmailService } from '@/lib/services/emailService';
import { ChatAttachmentService } from '@/lib/services/chatAttachmentService';
import type { EmailAttachment } from '@/lib/ses';
import {
  attachedHtmlSpecSchema,
  prepareAttachedHtml,
  resolveHtmlAttachment,
  turnAttachmentRefs,
} from './attachedHtml';
import {
  companyExcelSpecSchema,
  researchSummarySpecSchema,
  presentationSpecSchema,
  companyCardSpecSchema,
  buildCompanyExcelAttachment,
  buildResearchSummaryAttachment,
  ResearchSummaryTooLargeError,
  buildPresentationAttachment,
  buildCompanyCardAttachment,
} from './emailArtifacts';
import { COMPANY_FILTER_DOC } from './companyFilters';

/**
 * send_email — send ONE agent-composed email to one or more platform users.
 *
 * The email always carries a free-form subject + body, and may additionally
 * carry, in the SAME message:
 *   - a comprehensive company Excel workbook (`company_excel`), and/or
 *   - a formatted research-summary PDF (`research_summary`), and/or
 *   - the Company Card deck (`company_card`) — the "L0 → L1 Submission" card
 *     from the company detail view, rendered slide-for-slide, and/or
 *   - a flexible PowerPoint deck (`presentation`) — Workforce only.
 *
 * It can also send an HTML file the user uploaded in chat (`attached_html`) as
 * the email's body: the bytes are read back from S3 and reformatted into the
 * static subset mail clients render (`toEmailSafeHtml`), then shown inside the
 * branded shell. The model names the file; it never retypes it. A page that
 * only draws itself once its JavaScript runs is refused rather than mailed
 * blank.
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
 * Available to both the copilot chat and the workforce agent. PowerPoint
 * (`presentation`) uses the same inline path as Excel/PDF.
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
      'Optional: attach a comprehensive multi-sheet company Excel (.xlsx). Run query_companies first and pass the ids it returned as company_ids, or pass any of the same filters. Omit if no spreadsheet is wanted.',
    ),
  research_summary: researchSummarySpecSchema
    .optional()
    .describe(
      'Optional: attach a formatted research-summary PDF built from these sections. Omit if no PDF is wanted.',
    ),
  presentation: presentationSpecSchema
    .optional()
    .describe(
      'Optional: attach a flexible PowerPoint (.pptx) built from title + brief (+ optional company_names). Same self-service path as Excel/PDF — may take several minutes.',
    ),
  attached_html: attachedHtmlSpecSchema
    .optional()
    .describe(
      "Optional: send an HTML file the user uploaded in this chat as the email's body. Pass the file's name in file_name (omit it when only one HTML file is attached). Use this whenever the user asks to send/forward an attached HTML page — never retype the document yourself.",
    ),
  company_card: companyCardSpecSchema
    .optional()
    .describe(
      'Optional: attach the Company Card (.pptx) — the exact "L0 to L1 Submission" card from the company detail view. Run query_companies first and pass the ids it returned as company_ids (company_names is the fallback). Use this whenever the user asks to send a company detail / company card as a PPTX.',
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
      )}, pdf=${Boolean(args.research_summary)}, pptx=${Boolean(args.presentation)}, card=${Boolean(
        args.company_card,
      )}, html=${Boolean(args.attached_html)})`,
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

      // SES raw messages are ~10MB; keep the total payload under ~5.5MB so
      // base64 (~4/3) + MIME headers still fit. An uploaded HTML body counts
      // against the same budget — it rides in the same message.
      const SES_SAFE_ATTACHMENT_BYTES = 5_500_000;

      // ── Optional: an uploaded HTML file sent as the email body. ──
      // Read back from S3 rather than from anything the model wrote: a large
      // file only ever reached the model as an outline, so only the stored
      // bytes are the document the user uploaded. It is then reformatted into
      // the static subset mail clients render — a page that needs JavaScript
      // would otherwise arrive blank. Resolved before the attachment builders
      // below so a wrong or unsendable file fails fast, before a deck render
      // pays for a headless browser.
      let documentHtml: string | undefined;
      let documentName: string | undefined;
      let documentNote: string | null = null;
      if (args.attached_html) {
        const resolved = resolveHtmlAttachment(
          turnAttachmentRefs(runtime?.configurable),
          args.attached_html,
        );
        if (!resolved.ref) {
          return `**Error:** ${resolved.error}`;
        }
        const chatAttachments = new ChatAttachmentService(await getActiveWorkspaceId());
        const buffer = await chatAttachments.download(resolved.ref.key);
        if (buffer.length > SES_SAFE_ATTACHMENT_BYTES) {
          return `**Error:** "${resolved.ref.fileName}" is too large to send as an email body (~5.5MB limit). Ask the user for a smaller file.`;
        }
        const prepared = prepareAttachedHtml(buffer, resolved.ref.fileName);
        if (!prepared.html) {
          return `**Error:** ${prepared.error}`;
        }
        if (Buffer.byteLength(prepared.html, 'utf-8') > SES_SAFE_ATTACHMENT_BYTES) {
          return `**Error:** "${resolved.ref.fileName}" is too large to send as an email body (~5.5MB limit). Ask the user for a smaller file.`;
        }
        documentHtml = prepared.html;
        documentName = resolved.ref.fileName;
        documentNote = prepared.note;
      }
      const documentBytes = documentHtml ? Buffer.byteLength(documentHtml, 'utf-8') : 0;

      // ── Build attachments (shared by every recipient). ──
      const attachments: EmailAttachment[] = [];
      const attachmentLabels: string[] = [];
      const notes: string[] = [];
      const attachmentBytes = () =>
        documentBytes + attachments.reduce((sum, a) => sum + a.content.length, 0);

      if (args.research_summary) {
        try {
          const artifact = await buildResearchSummaryAttachment(
            args.research_summary,
            recipients.length === 1 ? recipients[0].email : undefined,
          );
          attachments.push(artifact.attachment);
          attachmentLabels.push('research summary (PDF)');
        } catch (err) {
          // Surfaced as its own error rather than through the outer catch, so
          // the model is told the PDF was the problem and nothing was sent.
          if (err instanceof ResearchSummaryTooLargeError) {
            return `**Error:** ${err.message}`;
          }
          throw err;
        }
      }

      if (args.company_excel) {
        const artifact = await buildCompanyExcelAttachment(args.company_excel);
        if (artifact) {
          attachments.push(artifact.attachment);
          attachmentLabels.push(
            `company Excel (${artifact.companyCount} compan${artifact.companyCount === 1 ? 'y' : 'ies'})`,
          );
          notes.push(...artifact.notes);
        } else {
          notes.push(
            'No companies matched the Excel filter, so the spreadsheet was not attached.',
          );
        }
      }

      if (args.company_card) {
        // Rendering a card deck launches a headless browser — check the size
        // budget before paying for it, not after.
        if (SES_SAFE_ATTACHMENT_BYTES - attachmentBytes() < 100_000) {
          return `**Error:** Existing attachments already use most of the email size budget; cannot add the Company Card deck. Send it in a separate email or drop the Excel/PDF.`;
        }
        const artifact = await buildCompanyCardAttachment(args.company_card);
        if (artifact) {
          attachments.push(artifact.attachment);
          attachmentLabels.push(
            `company card (PPTX: ${artifact.companyTitles.join(', ')} — ${artifact.slideCount} slide${
              artifact.slideCount === 1 ? '' : 's'
            })`,
          );
          notes.push(...artifact.notes);
        } else {
          notes.push(
            'None of the requested companies could be resolved, so the Company Card deck was not attached.',
          );
        }
      }

      if (args.presentation) {
        const remaining = SES_SAFE_ATTACHMENT_BYTES - attachmentBytes();
        if (remaining < 100_000) {
          return `**Error:** Existing attachments already use most of the email size budget; cannot add a PowerPoint. Send the deck in a separate email or drop the Excel/PDF.`;
        }
        const artifact = await buildPresentationAttachment(args.presentation, {
          maxBytes: remaining,
          signal: runtime?.signal,
        });
        attachments.push(artifact.attachment);
        attachmentLabels.push(`presentation (PPTX: ${artifact.title})`);
        notes.push(...artifact.notes);
      }

      if (attachmentBytes() > SES_SAFE_ATTACHMENT_BYTES) {
        return `**Error:** Combined attachments exceed the email size limit (~5.5MB raw). Remove an attachment or shrink the deck and try again.`;
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
            documentHtml,
          });
          sent.push(r.email);
          logger.info(
            `📧 send_email → ${r.email} (${attachments.length} attachment(s)${
              documentName ? `, body=${documentName}` : ''
            }, messageId=${messageId || 'n/a'})`,
          );
        } catch (err) {
          failed.push(r.email);
          logger.error(`send_email to ${r.email} failed: ${(err as Error).message}`);
        }
      }

      if (documentNote) notes.push(`The page was ${documentNote}.`);

      const parts: string[] = [];
      if (sent.length > 0) {
        const withPart =
          attachmentLabels.length > 0 ? ` with ${attachmentLabels.join(' + ')}` : '';
        const bodyPart = documentName ? ` using "${documentName}" as the email body` : '';
        parts.push(
          `Sent to ${sent.length} platform user(s)${bodyPart}${withPart}: ${sent.join(', ')}.`,
        );
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
    description: `Send ONE email to one or more platform users. You compose the subject and body; you may also attach a company spreadsheet, a research PDF, and/or a PowerPoint (a Company Card export or a free-form deck) — everything goes in a SINGLE email, never split across multiple messages.

IMPORTANT — recipients are restricted to a whitelist: only addresses that belong to a registered platform user (the users table) can be emailed. Omit \`to\` to send to the signed-in user (resolved by the runtime — you do NOT need their address). Any \`to\` address that is not a known platform user is silently skipped and reported back; the email is never delivered to non-platform addresses. Do NOT use this tool to email customers, bankers, or external parties.

VOICE — always write and sign on behalf of the app, "Investment Brain", NOT the human user. Do NOT sign off with an individual person's name. If you include a signature, sign as "Investment Brain".

## Company attachments run AFTER query_companies

\`company_excel\` and \`company_card\` both address companies by ID. The normal flow is:

1. Call \`query_companies\` with whatever the user asked for. Its result table's **ID** column holds each company's uuid.
2. Call \`send_email\` with those ids in \`company_excel.company_ids\` / \`company_card.company_ids\`.

That guarantees the attachment contains exactly the rows you just showed the user, instead of re-deriving a cohort from filters and quietly disagreeing with your own answer. Only skip step 1 when the user asked for a whole unfiltered cohort ("email me the entire pipeline") — then pass filters (or nothing) instead of ids.

## Attachments (optional — include only what the user asked for)

- \`company_excel\` — attach a comprehensive multi-sheet Excel (.xlsx) export of companies (profile + resolved sponsor/captain/enterer names + latest-year financials + AI Opinion, plus "Financials by Year", "Screening", and "FX Adjustments" sheets). Pass \`company_ids\` from a previous query_companies call, and/or any of the SAME filters query_companies accepts (see below), plus an optional \`title\`. Omit everything to export the entire pipeline (all stages). If nothing matches, the spreadsheet is skipped and the email still sends.

${COMPANY_FILTER_DOC}

- \`research_summary\` — attach a formatted PDF built from an ordered \`sections\` array. Each entry is one of:
  - \`heading\` { text, level?: "section" | "subsection" }
  - \`paragraph\` { text }
  - \`bullets\` { items }
  - \`kpi_cards\` { cards: [{ label, value, hint?, tone?, logo_url? }] } — a ruled grid, three per row; \`tone\` turns a status value into a pill
  - \`chart\` { type: "bar" | "stacked_bar" | "line" | "pie", title?, unit?, categories: [...], series: [{ name, values: [...] }] }
  - \`bar_chart\` { title?, unit?, data: [{ year, value }], accent?: "primary" | "secondary" } — the older single-series form; prefer \`chart\`
  - \`callout\` { tone?: "warning" | "takeaway" | "info" | "positive", title?, text?, items? } — a boxed aside; needs \`text\` or \`items\`
  - \`image\` { url, caption?, maxHeight? } — https PNG/JPEG only
  - \`gauges\` { gauges: [{ label, valuePct, tone?, trendLabel? }] }
  - \`scorecard\` { rows: [{ label, pill: { label, tone }, rationale, logo_url? }], columns?, overallPill?, overallNote? }
  - \`quadrants\` { quadrants: { topLeft, topRight, bottomLeft, bottomRight, xLabelLow?, xLabelHigh?, yLabelHigh?, yLabelLow? } }
  - \`priority_list\` { items: [{ priority: { label, tone: "high" | "medium" | "low" }, description, meta? }] }
  Pick the visual block whenever the data suits one; fall back to \`paragraph\` / \`bullets\` for narrative. Also pass a \`title\` (used for the PDF + filename) and optional \`references\`.
  Choosing a \`chart\` type: \`bar\` compares magnitudes across categories, \`stacked_bar\` shows the composition of a total, \`line\` shows a trend over an ordered axis, \`pie\` shows one share-of-whole split. Every series needs EXACTLY one value per category, in the same order — a shorter \`values\` array is rejected. \`stacked_bar\` stacks positive values only; for a series with negatives use \`bar\`. Keep one unit per chart (never mix revenue and a percentage in the same chart — use two).
  Using a \`callout\`: \`warning\` is the amber box for a caveat the reader must not miss — unverified figures, a data-quality note, a risk that qualifies the numbers above it. \`takeaway\` is a filled navy panel for the two to five things to remember; put one at the end of a long section or of the document. Give it a short all-caps-able \`title\` and keep it to the point the surrounding prose does not already make — a callout that repeats the paragraph above it only costs the reader a second reading.
  Rules: no markdown inside block strings. Text wraps and is never truncated, so write what the point needs rather than padding it to fill a card. \`logo_url\` is an https PNG/JPEG logo URL — pass one only when you already have it from a search or a page you read, never a guessed URL; one that cannot be fetched is skipped and the row still renders.

- \`company_card\` — Attach the **Company Card** deck (.pptx): a faithful, condensed export of the "L0 to L1 Submission" card shown in the company detail view (header + stage track, Project Type / Geography / Business Line / End Sector, Source / Deal Sponsor / Deal Status / NBO Due, Target Overview, Indicative Financials, Proposed Deal Structure, Investment Thesis, L1 scope of work, Kill criteria). Pass \`company_ids\` from a previous query_companies call (preferred — exact, no fuzzy matching), or \`company_names\` when you have no id. One slide set per company, in the order given; ids and names are deduplicated so the same company never appears twice. Optional \`title\`. Content that does not fit one slide continues on "(cont.)" slides. Ids/names that cannot be resolved are reported and skipped. This is FAST — it renders existing data and does NOT call an LLM.

- \`presentation\` — Attach a flexible PowerPoint (.pptx) via the Anthropic pptx skill. Pass \`title\`, free-form \`brief\` (outline/facts — slide count is flexible, NOT a fixed 7-slide template), and optional \`company_names\` to pull pipeline context. May take several minutes.

## Sending an uploaded HTML file

\`attached_html\` sends an HTML file the user uploaded in this chat as the email's **body**. Pass \`file_name\` (the name shown on the attachment chip); omit it only when a single HTML file is attached. The file is read from storage, so this works even when you only received an outline of it, and it needs NO Workforce handoff: emailing the file is not writing a document.

The file is not forwarded untouched — mail clients run no JavaScript and strip most of what a modern page is built from, so the tool first rewrites the document into the static subset they render (scripts, embedded frames, chart canvases, form controls and unreachable images come out; text, tables, styling and loadable images stay) and shows the result inside the Investment Brain email shell. The tool result says what was removed; pass that on to the user in your confirmation sentence.

Rules:
- Do NOT retype, summarize or re-author the document into \`body\` — that produces a reconstruction, not the user's file. Name the file and let the tool do the reformatting.
- \`body\` is still required: it is the note above the page, and the plain-text alternative for clients that do not render HTML. One or two sentences is enough.
- If the tool answers that the page builds its content with JavaScript, nothing was sent — that covers a file that only shows a loading screen ("Unpacking…", a logo and a spinner) until its bundle runs. Tell the user what the tool said the page renders, and offer to send it as a PDF or to work from a version whose content is in the HTML itself. Do NOT retry the same file.
- Works alongside the attachments above (e.g. the uploaded page as the body plus an Excel attached), and the file stays available on later turns of the same chat.

## Usage

- Plain note to a colleague → just \`to\` + \`subject\` + \`body\`.
- "Email me the pipeline as a spreadsheet" → \`body\` + \`company_excel\` with no filters (omit \`to\`).
- "Email me these as a spreadsheet" after you listed a cohort → run \`query_companies\`, then \`body\` + \`company_excel\` with \`company_ids: [<ids from that table>]\`.
- "Email me a summary and the L1 companies" → \`query_companies\` (stage="L1"), then \`body\` + \`research_summary\` + \`company_excel\` with those \`company_ids\` — ONE email, both attached.
- "Send me the company detail / company card for X as a PPTX", "email X's card as slides" → \`query_companies\` (name="X"), then \`body\` + \`company_card\` with \`company_ids: ["<X's id>"]\`. Use \`company_card\`, NOT \`presentation\`, whenever the user wants the company's existing card/detail as slides — it reproduces the real card instead of writing a new deck.
- "Email me a PowerPoint about X" (a NEW deck, free-form topic) → \`body\` + \`presentation\` (omit \`to\`).
- "Send this HTML to X", "forward the attached page", "email me this file" (an .html file is attached) → \`lookup_user\` if a person is named, then \`body\` (a one-line note) + \`attached_html\` with \`file_name: "<the attached file>"\`.
- Mix attachments in ONE call when asked (excel + pdf + pptx + company card).

After the tool returns, write ONE short sentence confirming, or surface its **Error:** verbatim.

Args:
    to: Optional. Recipient email addresses (each a registered platform user). Omit to send to the signed-in user.
    subject: Required. The email subject line.
    body: Required. Plain-text body (Markdown is NOT rendered). Sign off as "Investment Brain". With attached_html it is only the plain-text alternative.
    attached_html: Optional. file_name of an HTML file uploaded in this chat; it is reformatted for email and becomes the email's body.
    company_excel: Optional. company_ids from query_companies and/or filters (+ title) for an attached Excel workbook.
    research_summary: Optional. Title + sections (+ references) for an attached PDF.
    presentation: Optional. Title + brief (+ company_names) for an attached PowerPoint.
    company_card: Optional. company_ids (preferred) or company_names (+ title) for an attached Company Card deck.

Returns:
    A confirmation string listing recipients, what was attached, and any skipped addresses, or an error string starting with **Error:**.`,
    schema: argsSchema,
  },
);
