import {
  sendEmail,
  sendEmailWithAttachment,
  DEFAULT_FROM_EMAIL,
  type SendEmailInput,
  type SendEmailResult,
  type SendEmailWithAttachmentInput,
} from '@/lib/ses';

const RESET_PATH = '/reset-password';

/**
 * Allow a `sender` (the SES wrapper) to be injected for tests. The default
 * implementation is the production `sendEmail` from `@/lib/ses`.
 */
export type EmailSender = (input: SendEmailInput) => Promise<SendEmailResult>;

export interface ForgotPasswordEmailInput {
  email: string;
  token: string;
  /**
   * The app's base URL used to build the reset link. Sourced from the
   * incoming request's origin in the API route, then carried through the
   * queue payload to this handler.
   */
  appUrl: string;
  /** Token TTL in minutes — surfaced in the body so users know the urgency. */
  ttlMinutes?: number;
}

/**
 * Build the reset URL that goes in the email body. Encodes the token to keep
 * special characters safe inside a query string.
 */
export function buildResetUrl(token: string, appUrl: string): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${base}${RESET_PATH}?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderForgotPasswordEmail(input: {
  resetUrl: string;
  ttlMinutes: number;
}): { subject: string; html: string; text: string } {
  const { resetUrl, ttlMinutes } = input;
  const safeUrl = escapeHtml(resetUrl);
  const subject = 'Reset your Brain 2.0 password';

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px; color:#111;">
    <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px; font-size:20px;">Reset your password</h1>
      <p style="margin:0 0 16px; line-height:1.5;">
        We received a request to reset the password for your Brain 2.0 account.
        Click the button below to choose a new password.
      </p>
      <p style="margin:24px 0;">
        <a
          href="${safeUrl}"
          style="display:inline-block; background:#111; color:#fff; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600;"
        >Reset password</a>
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        Or paste this link into your browser:<br />
        <a href="${safeUrl}" style="color:#2563eb; word-break:break-all;">${safeUrl}</a>
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        This link expires in ${ttlMinutes} minutes. If you didn't request a
        password reset, you can safely ignore this email — your current
        password will continue to work.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    'Reset your Brain 2.0 password',
    '',
    'We received a request to reset the password for your Brain 2.0 account.',
    'Open the following link in your browser to choose a new password:',
    '',
    resetUrl,
    '',
    `This link expires in ${ttlMinutes} minutes. If you didn't request a`,
    'password reset, you can safely ignore this email — your current',
    'password will continue to work.',
  ].join('\n');

  return { subject, html, text };
}

export interface ResearchSummaryEmailInput {
  /** Recipient address — typically the requesting user's own email. */
  email: string;
  /** Heading used in the email body and PDF document title. */
  title: string;
  /**
   * Markdown-ish summary text the agent already composed. Forwarded verbatim
   * into the PDF body (rendered with light heading/bullet handling).
   */
  summaryMarkdown: string;
  /** Pre-rendered PDF bytes to attach. */
  pdfBuffer: Buffer;
  /** Optional override for the email subject — defaults to `Research summary: <title>`. */
  subject?: string;
  /** Optional PDF attachment filename — defaults to a slug of the title. */
  filename?: string;
}

export type AttachmentSender = (
  input: SendEmailWithAttachmentInput,
) => Promise<SendEmailResult>;

export function renderResearchSummaryEmail(input: {
  title: string;
  summaryMarkdown: string;
}): { subject: string; html: string; text: string } {
  const subject = `Research summary: ${input.title}`;
  const safeTitle = escapeHtml(input.title);
  const preview = input.summaryMarkdown.length > 280
    ? `${input.summaryMarkdown.slice(0, 280).trim()}…`
    : input.summaryMarkdown;
  const safePreview = escapeHtml(preview).replace(/\n/g, '<br />');

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px; color:#111;">
    <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px; font-size:20px;">${safeTitle}</h1>
      <p style="margin:0 0 16px; line-height:1.5;">
        Your research summary is ready. The full write-up is attached as a PDF.
      </p>
      <div style="margin:16px 0; padding:16px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; color:#374151; font-size:14px; line-height:1.5;">
        ${safePreview}
      </div>
      <p style="margin:16px 0 0; color:#52525b; font-size:13px;">
        Sent by Brain 2.0 Copilot at your request.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    input.title,
    '',
    'Your research summary is ready. The full write-up is attached as a PDF.',
    '',
    preview,
    '',
    'Sent by Brain 2.0 Copilot at your request.',
  ].join('\n');

  return { subject, html, text };
}

// ───────────────────────────────────────────────────────────────────────────
// Task / routine notification emails (MB-90)
//
// One renderer + one EmailService method per notification kind. The renderers
// are pure (subject/html/text) so they can be unit-tested without SES, mirroring
// the forgot-password / research-summary pattern above. All user-supplied text
// is run through escapeHtml before interpolation into the HTML body.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Shared card shell used by every notification email so they share branding.
 * Renders the gradient header band ("Brain 2.0 — M&A Intelligence" + a
 * per-email `bannerTitle`), the caller-composed `bodyHtml`, an optional CTA
 * button (only when a URL is supplied), and a footer line.
 *
 * `bodyHtml` is trusted, pre-escaped markup composed by the caller; `accent`
 * (+ optional darker `accentDark`) colors the header gradient and the CTA.
 */
function renderNotificationShell(input: {
  bannerTitle: string;
  bodyHtml: string;
  accent: string;
  accentDark?: string;
  ctaUrl?: string;
  ctaLabel?: string;
  footer?: string;
}): string {
  const { bannerTitle, bodyHtml, accent } = input;
  const accentDark = input.accentDark ?? accent;
  const footer = input.footer ?? 'Sent by Brain 2.0.';
  const cta =
    input.ctaUrl && input.ctaLabel
      ? `<div style="text-align:center; margin:28px 0 4px;">
          <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block; background:#6d5ef5; color:#fff; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px;">${input.ctaLabel}</a>
        </div>`
      : '';
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f8; padding:24px; color:#111; margin:0;">
    <div style="max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e4e4e7;">
      <div style="background-color:${accent}; background-image:linear-gradient(135deg, ${accent}, ${accentDark}); padding:30px 32px; text-align:center;">
        <div style="color:rgba(255,255,255,0.88); font-size:13px;">Brain 2.0 — M&amp;A Intelligence</div>
        <div style="color:#fff; font-size:23px; font-weight:700; margin-top:8px;">${escapeHtml(bannerTitle)}</div>
      </div>
      <div style="padding:32px;">
        ${bodyHtml}
        ${cta}
      </div>
      <div style="padding:18px 32px; border-top:1px solid #efeff2;">
        <p style="margin:0; color:#a1a1aa; font-size:13px;">${escapeHtml(footer)}</p>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Uppercase muted section label, e.g. "SUMMARY" / "RESULTS". `text` is a
 * trusted static string (callers pass literals), so it is not escaped.
 */
function sectionLabel(text: string): string {
  return `<div style="text-transform:uppercase; letter-spacing:.06em; color:#a1a1aa; font-size:12px; font-weight:700; margin:28px 0 4px;">${text}</div>`;
}

/** A label-left / value-right row with a bottom rule. `highlight` greens the value. */
function kvRow(label: string, value: string, highlight = false): string {
  const valColor = highlight ? '#16a34a' : '#111';
  return `<tr>
    <td style="padding:14px 0; border-bottom:1px solid #efeff2; color:#52525b; font-size:15px; vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:14px 0 14px 16px; border-bottom:1px solid #efeff2; color:${valColor}; font-weight:700; font-size:15px; text-align:right; vertical-align:top;">${escapeHtml(value)}</td>
  </tr>`;
}

function kvTable(rowsHtml: string): string {
  return `<table width="100%" style="border-collapse:collapse;">${rowsHtml}</table>`;
}

export interface TaskCompletedRow {
  label: string;
  value: string;
  /** Render the value in green (used for pass-rate result rows). */
  highlight?: boolean;
}

export interface TaskCompletedEmailInput {
  email: string;
  taskName: string;
  taskUrl?: string;
  /** Pre-formatted "Finished at 2:42 PM on April 28, 2026". */
  finishedAtLabel?: string;
  /** SUMMARY section rows (Task / Started / Completed / Duration). */
  summaryRows?: TaskCompletedRow[];
  /** RESULTS section rows (e.g. Companies screened, Pass L0). */
  resultRows?: TaskCompletedRow[];
  /** Free-text fallback shown only when there are no structured result rows. */
  summary?: string;
}

export function renderTaskCompletedEmail(input: {
  taskName: string;
  taskUrl?: string;
  finishedAtLabel?: string;
  summaryRows?: TaskCompletedRow[];
  resultRows?: TaskCompletedRow[];
  summary?: string;
}): { subject: string; html: string; text: string } {
  const subject = `✅ ${input.taskName} — Complete`;

  const finishedHtml = input.finishedAtLabel
    ? `<p style="margin:0; color:#52525b; font-size:15px;">${escapeHtml(input.finishedAtLabel)}</p>`
    : '';

  const summarySection = input.summaryRows?.length
    ? `${sectionLabel('Summary')}${kvTable(input.summaryRows.map((r) => kvRow(r.label, r.value)).join(''))}`
    : '';

  const resultsSection = input.resultRows?.length
    ? `${sectionLabel('Results')}${kvTable(input.resultRows.map((r) => kvRow(r.label, r.value, r.highlight)).join(''))}`
    : '';

  // Only show the free-text summary when there's no structured RESULTS table.
  const summaryTextHtml =
    input.summary && !input.resultRows?.length
      ? `<div style="margin:16px 0 0; padding:16px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; color:#374151; font-size:14px; line-height:1.5;">${escapeHtml(input.summary).replace(/\n/g, '<br />')}</div>`
      : '';

  const html = renderNotificationShell({
    bannerTitle: '✅ Task Complete',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<p style="margin:0 0 8px; color:#16a34a; font-weight:700;">✔ Successfully completed</p>
      <h1 style="margin:0 0 8px; font-size:26px; line-height:1.2;">${escapeHtml(input.taskName)}</h1>
      ${finishedHtml}
      ${summarySection}
      ${resultsSection}
      ${summaryTextHtml}`,
    ctaUrl: input.taskUrl,
    ctaLabel: 'View Results →',
  });

  const text = [
    `${input.taskName} — Complete`,
    ...(input.finishedAtLabel ? ['', input.finishedAtLabel] : []),
    ...(input.summaryRows?.length
      ? ['', 'Summary:', ...input.summaryRows.map((r) => `  ${r.label}: ${r.value}`)]
      : []),
    ...(input.resultRows?.length
      ? ['', 'Results:', ...input.resultRows.map((r) => `  ${r.label}: ${r.value}`)]
      : input.summary
        ? ['', input.summary]
        : []),
    ...(input.taskUrl ? ['', `View Results: ${input.taskUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface TaskWaitingApprovalEmailInput {
  email: string;
  action: string;
  taskName?: string;
  taskUrl?: string;
  /** Structured "what's being proposed" fields (derived from the gated tool). */
  company?: string;
  proposedAction?: string;
  reason?: string;
  /** "Change preview" row — e.g. Pipeline Stage: L0 → L1. */
  changeField?: string;
  beforeValue?: string;
  afterValue?: string;
}

export function renderTaskWaitingApprovalEmail(input: {
  action: string;
  taskName?: string;
  taskUrl?: string;
  company?: string;
  proposedAction?: string;
  reason?: string;
  changeField?: string;
  beforeValue?: string;
  afterValue?: string;
}): { subject: string; html: string; text: string } {
  const subject = `⏳ ${input.action} — Needs Your Approval`;

  const rows = [
    input.company ? kvRow('Company', input.company) : '',
    input.proposedAction ? kvRow('Action', input.proposedAction) : '',
    input.reason ? kvRow('Reason', input.reason) : '',
  ].join('');
  const proposedSection = rows
    ? `${sectionLabel("What's being proposed")}${kvTable(rows)}`
    : '';

  const changeSection =
    input.changeField && input.beforeValue && input.afterValue
      ? `<div style="text-transform:uppercase; letter-spacing:.06em; color:#a1a1aa; font-size:12px; font-weight:700; margin:28px 0 8px;">Change preview</div>
         <table width="100%" style="border-collapse:collapse; border:1px solid #efeff2; border-radius:10px; overflow:hidden;">
           <tr style="background:#f7f7fa;">
             <th align="left" style="padding:12px 14px; font-size:12px; color:#52525b; font-weight:700;">Field</th>
             <th align="left" style="padding:12px 14px; font-size:12px; color:#52525b; font-weight:700;">Before</th>
             <th align="left" style="padding:12px 14px; font-size:12px; color:#52525b; font-weight:700;">After</th>
           </tr>
           <tr>
             <td style="padding:14px; font-size:16px; color:#111;">${escapeHtml(input.changeField)}</td>
             <td style="padding:14px; font-size:16px; color:#52525b;">${escapeHtml(input.beforeValue)}</td>
             <td style="padding:14px; font-size:16px; color:#16a34a; font-weight:700;">${escapeHtml(input.afterValue)} ✨</td>
           </tr>
         </table>`
      : '';

  const taskMeta = input.taskName
    ? `<p style="margin:8px 0 0; color:#a1a1aa; font-size:13px;">Task: ${escapeHtml(input.taskName)}</p>`
    : '';

  const html = renderNotificationShell({
    bannerTitle: '⏳ Approval Required',
    accent: '#e0962e',
    accentDark: '#c97a1f',
    footer: 'Review the full details in the app if you need more context.',
    bodyHtml: `<p style="margin:0 0 8px; color:#d97706; font-weight:700;">⏳ Waiting for your decision</p>
      <h1 style="margin:0 0 8px; font-size:26px; line-height:1.2;">${escapeHtml(input.action)}</h1>
      <p style="margin:0; color:#52525b; font-size:15px;">AI agent is waiting for your confirmation</p>
      ${taskMeta}
      ${proposedSection}
      ${changeSection}`,
    ctaUrl: input.taskUrl,
    ctaLabel: 'View Approval',
  });

  const text = [
    `${input.action} — Needs Your Approval`,
    '',
    'AI agent is waiting for your confirmation.',
    ...(input.taskName ? [`Task: ${input.taskName}`] : []),
    ...(input.company ? ['', `Company: ${input.company}`] : []),
    ...(input.proposedAction ? [`Action: ${input.proposedAction}`] : []),
    ...(input.reason ? [`Reason: ${input.reason}`] : []),
    ...(input.changeField && input.beforeValue && input.afterValue
      ? ['', `${input.changeField}: ${input.beforeValue} → ${input.afterValue}`]
      : []),
    ...(input.taskUrl ? ['', `View Approval: ${input.taskUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface TaskFailedEmailInput {
  email: string;
  taskName: string;
  reason?: string;
  cancelled?: boolean;
  taskUrl?: string;
}

export function renderTaskFailedEmail(input: {
  taskName: string;
  reason?: string;
  cancelled?: boolean;
  taskUrl?: string;
}): { subject: string; html: string; text: string } {
  const verb = input.cancelled ? 'Canceled' : 'Failed';
  const subject = `❌ ${input.taskName} — ${verb}`;
  const lead = input.cancelled
    ? 'This task was canceled before it finished.'
    : 'This task stopped before it could finish.';
  const reasonHtml = input.reason
    ? `<div style="margin:16px 0; padding:16px; background:#fef2f2; border-radius:6px; border:1px solid #fecaca; color:#991b1b; font-size:14px; line-height:1.5;">${escapeHtml(input.reason).replace(/\n/g, '<br />')}</div>`
    : '';
  const html = renderNotificationShell({
    bannerTitle: `❌ Task ${verb}`,
    accent: '#dc2626',
    accentDark: '#b91c1c',
    bodyHtml: `<p style="margin:0 0 6px; color:#dc2626; font-weight:700;">${verb}</p>
      <h1 style="margin:0 0 8px; font-size:24px;">${escapeHtml(input.taskName)}</h1>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b;">${lead}</p>${reasonHtml}`,
    ctaUrl: input.taskUrl,
    ctaLabel: 'View task',
  });
  const text = [
    `${input.taskName} — ${verb}`,
    '',
    lead,
    ...(input.reason ? ['', input.reason] : []),
    ...(input.taskUrl ? ['', `View task: ${input.taskUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface TaskProgressEmailInput {
  email: string;
  taskName: string;
  progress: string;
  headline?: string;
  taskUrl?: string;
}

export function renderTaskProgressEmail(input: {
  taskName: string;
  progress: string;
  headline?: string;
  taskUrl?: string;
}): { subject: string; html: string; text: string } {
  const headline = input.headline?.trim() || 'Progress Update';
  const subject = `⏳ ${input.taskName} — ${headline}`;
  const html = renderNotificationShell({
    bannerTitle: '⏳ Progress Update',
    accent: '#2563eb',
    accentDark: '#1d4ed8',
    bodyHtml: `<h1 style="margin:0 0 8px; font-size:24px;">${escapeHtml(input.taskName)}</h1>
      <p style="margin:0 0 4px; font-weight:700; color:#1d4ed8;">${escapeHtml(headline)}</p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b;">${escapeHtml(input.progress).replace(/\n/g, '<br />')}</p>`,
    ctaUrl: input.taskUrl,
    ctaLabel: 'View task',
  });
  const text = [
    `${input.taskName} — ${headline}`,
    '',
    input.progress,
    ...(input.taskUrl ? ['', `View task: ${input.taskUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface TaskInsightEmailInput {
  email: string;
  companyName: string;
  level: string;
  detail?: string;
  confidencePct?: number;
  taskUrl?: string;
}

export function renderTaskInsightEmail(input: {
  companyName: string;
  level: string;
  detail?: string;
  confidencePct?: number;
  taskUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `✅ ${input.companyName} — Passes ${input.level} Criteria`;
  const confidence =
    typeof input.confidencePct === 'number'
      ? ` (${Math.round(input.confidencePct)}% confidence)`
      : '';
  const detailHtml = input.detail
    ? `<div style="margin:16px 0; padding:16px; background:#f0fdf4; border-radius:6px; border:1px solid #bbf7d0; color:#166534; font-size:14px; line-height:1.5;">${escapeHtml(input.detail).replace(/\n/g, '<br />')}</div>`
    : '';
  const html = renderNotificationShell({
    bannerTitle: '✅ Opportunity',
    accent: '#16a34a',
    accentDark: '#15803d',
    bodyHtml: `<p style="margin:0 0 6px; color:#16a34a; font-weight:700;">Passes ${escapeHtml(input.level)} criteria</p>
      <h1 style="margin:0 0 8px; font-size:24px;">${escapeHtml(input.companyName)}</h1>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b;">${escapeHtml(input.companyName)} passed the <strong>${escapeHtml(input.level)}</strong> screening milestone${escapeHtml(confidence)}.</p>${detailHtml}`,
    ctaUrl: input.taskUrl,
    ctaLabel: 'View task',
  });
  const text = [
    `${input.companyName} — Passes ${input.level} Criteria`,
    '',
    `${input.companyName} passed the ${input.level} screening milestone${confidence}.`,
    ...(input.detail ? ['', input.detail] : []),
    ...(input.taskUrl ? ['', `View task: ${input.taskUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface AgentEmailInput {
  /** Recipient address. Callers (the send_email tool) must have already
   * validated this against the platform user whitelist. */
  email: string;
  subject: string;
  /** Plain-text body composed by the agent. Newlines become <br /> in HTML. */
  body: string;
}

/**
 * Render a generic agent-composed email. Used by the `send_email` tool so the
 * agent can send free-form messages (the body is supplied by the model) while
 * still sharing the branded notification shell. The body is plain text — it is
 * HTML-escaped before interpolation, so no markup leaks through.
 */
const AGENT_EMAIL_DISCLAIMER =
  'This email was auto-generated using BRAIN.';

/** Display name every agent-composed email is sent on behalf of. */
export const AGENT_EMAIL_SENDER_NAME = 'MnA Brain 2.0';

/** Public URL of the app, surfaced in agent-composed emails. */
export const APP_URL = 'https://mna.sqe.co.id';

/**
 * Build the SES "From" header for agent emails so they are always sent on
 * behalf of "MnA Brain 2.0". Reuses the verified sender address from
 * DEFAULT_FROM_EMAIL (which may be either a bare address or already in
 * "Name <addr>" form) and just overrides the display name.
 */
export function buildAgentFromAddress(defaultFrom: string): string {
  const match = defaultFrom.match(/<([^>]+)>/);
  const address = (match ? match[1] : defaultFrom).trim();
  return `${AGENT_EMAIL_SENDER_NAME} <${address}>`;
}

export function renderAgentEmail(input: {
  subject: string;
  body: string;
}): { subject: string; html: string; text: string } {
  const safeBody = escapeHtml(input.body).replace(/\n/g, '<br />');
  const safeUrl = escapeHtml(APP_URL);
  const disclaimerHtml = `<p style="margin:24px 0 0; padding-top:16px; border-top:1px solid #efeff2; color:#a1a1aa; font-size:12px; font-style:italic; line-height:1.5;">${escapeHtml(
    AGENT_EMAIL_DISCLAIMER,
  )}<br />Open the app: <a href="${safeUrl}" style="color:#6d5ef5;">${safeUrl}</a></p>`;
  const html = renderNotificationShell({
    bannerTitle: AGENT_EMAIL_SENDER_NAME,
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; line-height:1.25;">${escapeHtml(input.subject)}</h1>
      <div style="margin:0; line-height:1.6; color:#374151; font-size:15px;">${safeBody}</div>
      ${disclaimerHtml}`,
    ctaUrl: APP_URL,
    ctaLabel: 'Open MnA Brain 2.0',
    footer: `Sent on behalf of ${AGENT_EMAIL_SENDER_NAME}.`,
  });
  const text = `${input.body}\n\n—\n${AGENT_EMAIL_DISCLAIMER}\nOpen the app: ${APP_URL}`;
  return { subject: input.subject, html, text };
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'research-summary';
}

export class EmailService {
  constructor(
    private readonly sender: EmailSender = sendEmail,
    private readonly attachmentSender: AttachmentSender = sendEmailWithAttachment,
  ) {}

  /**
   * Send the forgot-password email containing a reset link to the user.
   * The `token` is the raw reset token from `reset_password_tokens.token`.
   */
  async sendForgotPasswordEmail(
    input: ForgotPasswordEmailInput,
  ): Promise<SendEmailResult> {
    const { email, token, appUrl } = input;
    if (!email) throw new Error('sendForgotPasswordEmail: email is required');
    if (!token) throw new Error('sendForgotPasswordEmail: token is required');
    if (!appUrl) throw new Error('sendForgotPasswordEmail: appUrl is required');

    const ttlMinutes = input.ttlMinutes ?? 60;
    const resetUrl = buildResetUrl(token, appUrl);
    const { subject, html, text } = renderForgotPasswordEmail({ resetUrl, ttlMinutes });

    return this.sender({
      to: email,
      subject,
      html,
      text,
    });
  }

  /**
   * Send a research-summary email with the agent-composed write-up attached
   * as a PDF. The HTML/text body carries a short preview so the message is
   * useful even before opening the attachment.
   */
  async sendResearchSummaryEmail(
    input: ResearchSummaryEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) {
      throw new Error('sendResearchSummaryEmail: email is required');
    }
    if (!input.title) {
      throw new Error('sendResearchSummaryEmail: title is required');
    }
    if (!input.summaryMarkdown) {
      throw new Error('sendResearchSummaryEmail: summaryMarkdown is required');
    }
    if (!input.pdfBuffer || input.pdfBuffer.length === 0) {
      throw new Error('sendResearchSummaryEmail: pdfBuffer is required');
    }

    const { subject, html, text } = renderResearchSummaryEmail({
      title: input.title,
      summaryMarkdown: input.summaryMarkdown,
    });

    const filename = input.filename ?? `${slugifyTitle(input.title)}.pdf`;

    return this.attachmentSender({
      to: input.email,
      subject: input.subject ?? subject,
      html,
      text,
      attachments: [
        {
          filename,
          content: input.pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
  }

  /** Task reached terminal `succeeded`. */
  async sendTaskCompletedEmail(
    input: TaskCompletedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendTaskCompletedEmail: email is required');
    if (!input.taskName) {
      throw new Error('sendTaskCompletedEmail: taskName is required');
    }
    const { subject, html, text } = renderTaskCompletedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Task paused on a gated tool — `waiting_for_human_input`. */
  async sendTaskWaitingApprovalEmail(
    input: TaskWaitingApprovalEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) {
      throw new Error('sendTaskWaitingApprovalEmail: email is required');
    }
    if (!input.action) {
      throw new Error('sendTaskWaitingApprovalEmail: action is required');
    }
    const { subject, html, text } = renderTaskWaitingApprovalEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Task reached terminal `failed` (agent error or user cancellation). */
  async sendTaskFailedEmail(
    input: TaskFailedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendTaskFailedEmail: email is required');
    if (!input.taskName) {
      throw new Error('sendTaskFailedEmail: taskName is required');
    }
    const { subject, html, text } = renderTaskFailedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Mid-run progress milestone. */
  async sendTaskProgressEmail(
    input: TaskProgressEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendTaskProgressEmail: email is required');
    if (!input.taskName) {
      throw new Error('sendTaskProgressEmail: taskName is required');
    }
    if (!input.progress) {
      throw new Error('sendTaskProgressEmail: progress is required');
    }
    const { subject, html, text } = renderTaskProgressEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Opportunity insight — a company passed a screening milestone. */
  async sendTaskInsightEmail(
    input: TaskInsightEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendTaskInsightEmail: email is required');
    if (!input.companyName) {
      throw new Error('sendTaskInsightEmail: companyName is required');
    }
    if (!input.level) throw new Error('sendTaskInsightEmail: level is required');
    const { subject, html, text } = renderTaskInsightEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /**
   * Send a generic agent-composed email. The recipient MUST be a registered
   * platform user — that whitelist check lives in the `send_email` tool, not
   * here, so this method just renders and sends.
   */
  async sendAgentEmail(input: AgentEmailInput): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendAgentEmail: email is required');
    if (!input.subject) throw new Error('sendAgentEmail: subject is required');
    if (!input.body) throw new Error('sendAgentEmail: body is required');
    const { subject, html, text } = renderAgentEmail(input);
    return this.sender({
      to: input.email,
      subject,
      html,
      text,
      from: buildAgentFromAddress(DEFAULT_FROM_EMAIL),
    });
  }

}
