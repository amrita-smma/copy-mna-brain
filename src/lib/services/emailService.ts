import {
  sendEmail,
  sendEmailWithAttachment,
  DEFAULT_FROM_EMAIL,
  type SendEmailInput,
  type SendEmailResult,
  type SendEmailWithAttachmentInput,
  type EmailAttachment,
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
  const ttlLabel = formatTtl(ttlMinutes);
  const subject = 'Reset your Investment Brain password';

  const html = renderNotificationShell({
    bannerTitle: 'Reset your password',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">
        We received a request to reset the password for your Investment Brain account.
        Click the button below to choose a new password.
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        Or paste this link into your browser:<br />
        <a href="${safeUrl}" style="color:#2563eb; word-break:break-all;">${safeUrl}</a>
      </p>
      <p style="margin:0; line-height:1.5; color:#a1a1aa; font-size:13px;">
        This link expires in ${ttlLabel}. If you didn't request a password
        reset, you can safely ignore this email — your current password will
        continue to work.
      </p>`,
    ctaUrl: resetUrl,
    ctaLabel: 'Reset password',
    footer: 'Sent by Investment Brain.',
  });

  const text = [
    'Reset your Investment Brain password',
    '',
    'We received a request to reset the password for your Investment Brain account.',
    'Open the following link in your browser to choose a new password:',
    '',
    resetUrl,
    '',
    `This link expires in ${ttlLabel}. If you didn't request a`,
    'password reset, you can safely ignore this email — your current',
    'password will continue to work.',
  ].join('\n');

  return { subject, html, text };
}

export interface AccountInviteEmailInput {
  email: string;
  /** Display name used in the "Hi <name>," greeting. */
  name: string;
  token: string;
  /**
   * The app's base URL used to build the set-password link. Sourced from the
   * incoming request's origin in the API route, then carried through the
   * queue payload to this handler.
   */
  appUrl: string;
  /** Token TTL in minutes — surfaced in the body so users know the urgency. */
  ttlMinutes?: number;
}

/** Renders a TTL in minutes as whole days when it divides evenly, else minutes. */
function formatTtl(ttlMinutes: number): string {
  if (ttlMinutes > 0 && ttlMinutes % (24 * 60) === 0) {
    const days = ttlMinutes / (24 * 60);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${ttlMinutes} minutes`;
}

export function renderAccountInviteEmail(input: {
  name: string;
  resetUrl: string;
  ttlMinutes: number;
}): { subject: string; html: string; text: string } {
  const { name, resetUrl, ttlMinutes } = input;
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  const ttlLabel = formatTtl(ttlMinutes);
  const subject = 'Welcome to Investment Brain!';

  const html = renderNotificationShell({
    bannerTitle: 'Welcome to Brain!',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">Hi ${safeName},</p>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">
        Welcome to Brain! Please click the button below to set your password and log in.
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b; font-size:14px;">
        Or paste this link into your browser:<br />
        <a href="${safeUrl}" style="color:#2563eb; word-break:break-all;">${safeUrl}</a>
      </p>
      <p style="margin:0 0 16px; line-height:1.5; color:#a1a1aa; font-size:13px;">
        This link expires in ${ttlLabel}.
      </p>
      <p style="margin:0; line-height:1.6; color:#374151; font-size:15px;">
        If you have any questions, please don't hesitate to reach out to us!
      </p>`,
    ctaUrl: resetUrl,
    ctaLabel: 'Set your password',
    footer: 'Sent by Investment Brain.',
  });

  const text = [
    `Hi ${name},`,
    '',
    'Welcome to Brain! Please click the link below to set your password and log in.',
    '',
    resetUrl,
    '',
    `This link expires in ${ttlLabel}.`,
    '',
    "If you have any questions, please don't hesitate to reach out to us!",
    '',
    '— Investment Brain',
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

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface CompanyExcelEmailInput {
  /** Recipient address — a registered platform user, validated by the caller. */
  email: string;
  /** Heading used in the email body and as the filename slug base. */
  title: string;
  /** Number of companies included — surfaced in the body for a quick sanity check. */
  companyCount: number;
  /** Pre-rendered .xlsx bytes to attach. */
  excelBuffer: Buffer;
  /** One-line description of the filter used, shown in the body. */
  filterSummary?: string;
  /** Optional override for the email subject. */
  subject?: string;
  /** Optional attachment filename — defaults to a slug of the title. */
  filename?: string;
}

export function renderCompanyExcelEmail(input: {
  title: string;
  companyCount: number;
  filterSummary?: string;
}): { subject: string; html: string; text: string } {
  const subject = `Company export: ${input.title}`;
  const safeTitle = escapeHtml(input.title);
  const safeFilter = input.filterSummary
    ? escapeHtml(input.filterSummary)
    : 'All companies (no filter applied).';
  const countLine = `${input.companyCount} ${
    input.companyCount === 1 ? 'company' : 'companies'
  } included.`;

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px; color:#111;">
    <div style="max-width:560px; margin:0 auto; background:#fff; border-radius:8px; padding:32px; border:1px solid #e4e4e7;">
      <h1 style="margin:0 0 16px; font-size:20px;">${safeTitle}</h1>
      <p style="margin:0 0 16px; line-height:1.5;">
        Your company export is ready. The full detail is attached as an Excel workbook
        (companies, financials by year, screening, and FX adjustments across multiple sheets).
      </p>
      <div style="margin:16px 0; padding:16px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; color:#374151; font-size:14px; line-height:1.5;">
        <strong>${escapeHtml(countLine)}</strong><br />
        Filter: ${safeFilter}
      </div>
      <p style="margin:16px 0 0; color:#52525b; font-size:13px;">
        Sent by Investment Brain Copilot at your request.
      </p>
    </div>
  </body>
</html>`;

  const text = [
    input.title,
    '',
    'Your company export is ready. The full detail is attached as an Excel workbook',
    '(companies, financials by year, screening, and FX adjustments across multiple sheets).',
    '',
    countLine,
    `Filter: ${input.filterSummary ?? 'All companies (no filter applied).'}`,
    '',
    'Sent by Investment Brain Copilot at your request.',
  ].join('\n');

  return { subject, html, text };
}

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
        Sent by Investment Brain Copilot at your request.
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
    'Sent by Investment Brain Copilot at your request.',
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
 * Renders the gradient header band ("Investment Brain — M&A Intelligence" + a
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
  /**
   * Card width. The 600px default is the notification width; an email that
   * carries a whole document widens so the document's own layout is not
   * squeezed into a notification column.
   */
  maxWidthPx?: number;
}): string {
  const { bannerTitle, bodyHtml, accent } = input;
  const accentDark = input.accentDark ?? accent;
  const footer = input.footer ?? 'Sent by Investment Brain.';
  const maxWidth = input.maxWidthPx ?? 600;
  const cta =
    input.ctaUrl && input.ctaLabel
      ? `<div style="text-align:center; margin:28px 0 4px;">
          <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block; background:#6d5ef5; color:#fff; padding:14px 32px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px;">${input.ctaLabel}</a>
        </div>`
      : '';
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f8; padding:24px; color:#111; margin:0;">
    <div style="max-width:${maxWidth}px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; border:1px solid #e4e4e7;">
      <div style="background-color:${accent}; background-image:linear-gradient(135deg, ${accent}, ${accentDark}); padding:30px 32px; text-align:center;">
        <div style="color:rgba(255,255,255,0.88); font-size:13px;">Investment Brain — M&amp;A Intelligence</div>
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

export interface InsightRefreshedEmailInput {
  email: string;
  insightName: string;
  versionNo: number;
  insightUrl?: string;
}

export function renderInsightRefreshedEmail(input: {
  insightName: string;
  versionNo: number;
  insightUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `"${input.insightName}" was refreshed`;
  const safeName = escapeHtml(input.insightName);
  const versionText = `A scheduled refresh published version ${input.versionNo}.`;

  const html = renderNotificationShell({
    bannerTitle: 'Insight Refreshed',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<h1 style="margin:0 0 8px; font-size:24px;">${safeName}</h1>
      <p style="margin:0 0 16px; line-height:1.5; color:#52525b;">${versionText}</p>`,
    ctaUrl: input.insightUrl,
    ctaLabel: 'Open insight',
  });

  const text = [
    `"${input.insightName}" was refreshed`,
    '',
    input.insightName,
    versionText,
    ...(input.insightUrl ? ['', `Open insight: ${input.insightUrl}`] : []),
  ].join('\n');

  return { subject, html, text };
}

export interface TaskReminderEmailInput {
  email: string;
  /** The to-do the user wrote for themselves. */
  taskTitle: string;
  /** Deep link to the user's task list; defaults to the app root. */
  tasksUrl?: string;
}

/** A personal to-do's reminder time has passed and the task is still open. */
export function renderTaskReminderEmail(
  input: Omit<TaskReminderEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  // The title is user-written; keep it from breaking out of the Subject header.
  const subject = `Reminder: ${sanitizeEmailHeaderFragment(input.taskTitle)}`;
  const ctaUrl = input.tasksUrl || APP_URL;
  const body = 'The reminder you set for this task is due and it is still open.';

  const html = renderNotificationShell({
    bannerTitle: 'Task Reminder',
    accent: '#2563eb',
    accentDark: '#1d4ed8',
    bodyHtml: `<h1 style="margin:0 0 8px; font-size:22px; line-height:1.25;">${escapeHtml(input.taskTitle)}</h1>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">${body}</p>`,
    ctaUrl,
    ctaLabel: 'Open your tasks',
    footer: 'You are receiving this because you set a reminder on this task.',
  });

  const text = [input.taskTitle, '', body, '', `Open your tasks: ${ctaUrl}`].join('\n');

  return { subject, html, text };
}

export interface CompanyAssignedEmailInput {
  email: string;
  /** Display name of the assignee (the email recipient / custodian). */
  recipientName: string;
  companyName: string;
  /** Banker/bank the source email came from, when resolved. */
  bankerSource?: string;
  /** Deep link to the company's pipeline page. */
  companyUrl?: string;
}

/**
 * Notify a user that a company auto-created from a banker email was assigned
 * to them (stamped as `entered_by`) because they were a recipient of the
 * original email. Asks them to verify the extracted data or reroute to the
 * correct PIC.
 */
export function renderCompanyAssignedEmail(input: {
  recipientName: string;
  companyName: string;
  bankerSource?: string;
  companyUrl?: string;
}): { subject: string; html: string; text: string } {
  const subject = `📌 ${input.companyName} — Assigned to you for verification`;
  const bankPhrase = input.bankerSource
    ? `this bank (${input.bankerSource})`
    : 'this bank';
  const message =
    `Hey, ${input.recipientName}, you have been assigned this company ` +
    `${input.companyName} because you are one of the email recipients from ` +
    `${bankPhrase}. Please verify whether the information is correct or ` +
    'redirect it to the correct PIC.';
  const html = renderNotificationShell({
    bannerTitle: '📌 Company Assigned',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<p style="margin:0 0 8px; color:#52525b; font-size:15px;">Hey, ${escapeHtml(input.recipientName)},</p>
      <h1 style="margin:0 0 12px; font-size:24px; line-height:1.25;">${escapeHtml(input.companyName)}</h1>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">You have been assigned this company because you are one of the email recipients from ${escapeHtml(bankPhrase)}.</p>
      <p style="margin:0; line-height:1.6; color:#374151; font-size:15px;">Please verify whether the information is correct or redirect it to the correct PIC.</p>`,
    ctaUrl: input.companyUrl,
    ctaLabel: 'Review Company →',
  });
  const text = [
    message,
    ...(input.companyUrl ? ['', `Review the company: ${input.companyUrl}`] : []),
  ].join('\n');
  return { subject, html, text };
}

export interface EmailPdfIngestedRow {
  label: string;
  value: string;
}

export interface EmailPdfIngestedEmailInput {
  email: string;
  /** Display name of the mailbox custodian whose email was crawled. */
  recipientName?: string;
  /** Original attachment file name, e.g. "Project Atlas - Teaser.pdf". */
  fileName: string;
  /** Workspace the file landed in (display name). */
  workspaceName: string;
  /** Extra workspaces the same file fanned out to, when the mailbox is
   *  watched by more than one workspace. */
  additionalWorkspaces?: string[];
  /** Classified document type, already humanised (e.g. "Prospectus"). */
  fileTypeLabel?: string;
  /** Human-readable size, e.g. "1.4 MB". */
  fileSizeLabel?: string;
  /** Bank / sender the crawled email came from. */
  bankerSource?: string;
  /** Sender of the email the attachment arrived on, e.g. `Jane Doe <j@bank.com>`. */
  emailSender?: string;
  /** Subject line of that email. */
  emailSubject?: string;
  /** Pre-formatted receipt time, e.g. `28 Sep 2026, 14:32 UTC`. */
  emailReceivedLabel?: string;
  /** Document date extracted by the classifier (ISO or display string). */
  fileDateLabel?: string;
  /** Companies the file was matched to or auto-created for. */
  matchedCompanies?: string[];
  /** Classifier tags. */
  tags?: string[];
  /** True when the file landed in the HITL review queue rather than completing. */
  awaitingReview?: boolean;
  /** Deep link to the file in Smart Files. */
  fileUrl?: string;
}

/**
 * Notify the mailbox custodian that a PDF attachment crawled from their email
 * was ingested into Brain. Sent once per ingested PDF, listing the file's
 * metadata and the workspace it landed in so the custodian can spot a
 * misrouted or unexpected document straight away.
 */
export function renderEmailPdfIngestedEmail(
  input: EmailPdfIngestedEmailInput,
): { subject: string; html: string; text: string } {
  const subject = `📄 ${input.fileName} added to ${input.workspaceName}`;

  const rows: EmailPdfIngestedRow[] = [{ label: 'File', value: input.fileName }];
  if (input.fileTypeLabel) rows.push({ label: 'Document type', value: input.fileTypeLabel });
  if (input.fileSizeLabel) rows.push({ label: 'Size', value: input.fileSizeLabel });
  if (input.fileDateLabel) rows.push({ label: 'Document date', value: input.fileDateLabel });
  if (input.emailSender) rows.push({ label: 'From', value: input.emailSender });
  else if (input.bankerSource) rows.push({ label: 'From', value: input.bankerSource });
  if (input.emailSubject) rows.push({ label: 'Email subject', value: input.emailSubject });
  if (input.emailReceivedLabel) {
    rows.push({ label: 'Received', value: input.emailReceivedLabel });
  }
  rows.push({ label: 'Workspace', value: input.workspaceName });
  if (input.additionalWorkspaces && input.additionalWorkspaces.length > 0) {
    rows.push({
      label: 'Also added to',
      value: input.additionalWorkspaces.join(', '),
    });
  }
  if (input.matchedCompanies && input.matchedCompanies.length > 0) {
    rows.push({ label: 'Companies', value: input.matchedCompanies.join(', ') });
  }
  if (input.tags && input.tags.length > 0) {
    rows.push({ label: 'Tags', value: input.tags.join(', ') });
  }
  rows.push({
    label: 'Status',
    value: input.awaitingReview ? 'Awaiting your review' : 'Processed',
  });

  const greeting = input.recipientName
    ? `<p style="margin:0 0 8px; color:#52525b; font-size:15px;">Hey, ${escapeHtml(input.recipientName)},</p>`
    : '';
  const reviewNote = input.awaitingReview
    ? '<p style="margin:16px 0 0; line-height:1.6; color:#374151; font-size:15px;">This document needs a human review before its extracted data is applied.</p>'
    : '';

  const html = renderNotificationShell({
    bannerTitle: '📄 New Document Added',
    accent: '#0ea5e9',
    accentDark: '#0369a1',
    bodyHtml: `${greeting}
      <h1 style="margin:0 0 12px; font-size:24px; line-height:1.25;">${escapeHtml(input.fileName)}</h1>
      <p style="margin:0 0 4px; line-height:1.6; color:#374151; font-size:15px;">A PDF attached to your email was scanned and added to <strong>${escapeHtml(input.workspaceName)}</strong> in Investment Brain.</p>
      ${sectionLabel('DETAILS')}
      ${kvTable(rows.map((r) => kvRow(r.label, r.value)).join(''))}
      ${reviewNote}`,
    ctaUrl: input.fileUrl,
    ctaLabel: 'View Document →',
    footer:
      'Sent by Investment Brain because this document arrived in a mailbox synced to your account.',
  });

  const text = [
    ...(input.recipientName ? [`Hey, ${input.recipientName},`, ''] : []),
    `A PDF attached to your email was scanned and added to ${input.workspaceName} in Investment Brain.`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    ...(input.fileUrl ? ['', `View the document: ${input.fileUrl}`] : []),
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

export interface ComposedEmailInput {
  /** Recipient address. Callers (the send_email tool) must have already
   * validated this against the platform user whitelist. */
  email: string;
  subject: string;
  /** Plain-text body composed by the agent. Newlines become <br /> in HTML. */
  body: string;
  /**
   * Optional file attachments (e.g. a company Excel workbook and/or a research
   * PDF), all delivered in this SINGLE email. When empty, a plain email is sent.
   */
  attachments?: EmailAttachment[];
  /**
   * An uploaded HTML document, already reformatted by `toEmailSafeHtml` into
   * the static subset mail clients render. Set by the `send_email` tool when
   * the user uploaded an HTML file in chat and asked for it to be sent. It is
   * shown under the note inside the branded shell; `body` stays the
   * plain-text alternative.
   */
  documentHtml?: string;
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
export const AGENT_EMAIL_SENDER_NAME = 'Investment Brain';

/** Public URL of the app, surfaced in agent-composed emails. */
export const APP_URL = 'https://mna.sqe.co.id';

/**
 * Build the SES "From" header for agent emails so they are always sent on
 * behalf of "Investment Brain". Reuses the verified sender address from
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
  /**
   * An uploaded document, already reformatted into the email-safe subset by
   * `toEmailSafeHtml`. It is inserted under the note, inside the branded
   * shell — never escaped, because the rewriter has already removed
   * everything a mail client must not be handed.
   */
  documentHtml?: string;
}): { subject: string; html: string; text: string } {
  const safeBody = escapeHtml(input.body).replace(/\n/g, '<br />');
  const safeUrl = escapeHtml(APP_URL);
  const disclaimerHtml = `<p style="margin:24px 0 0; padding-top:16px; border-top:1px solid #efeff2; color:#a1a1aa; font-size:12px; font-style:italic; line-height:1.5;">${escapeHtml(
    AGENT_EMAIL_DISCLAIMER,
  )}<br />Open the app: <a href="${safeUrl}" style="color:#6d5ef5;">${safeUrl}</a></p>`;
  const documentHtml = input.documentHtml
    ? `<div style="margin:24px 0 0; padding-top:24px; border-top:1px solid #efeff2;">${input.documentHtml}</div>`
    : '';
  const html = renderNotificationShell({
    bannerTitle: AGENT_EMAIL_SENDER_NAME,
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; line-height:1.25;">${escapeHtml(input.subject)}</h1>
      <div style="margin:0; line-height:1.6; color:#374151; font-size:15px;">${safeBody}</div>
      ${documentHtml}
      ${disclaimerHtml}`,
    ctaUrl: APP_URL,
    ctaLabel: 'Open Investment Brain',
    footer: `Sent on behalf of ${AGENT_EMAIL_SENDER_NAME}.`,
    maxWidthPx: input.documentHtml ? 900 : undefined,
  });
  const documentNote = input.documentHtml
    ? '\n\n[The attached page is shown in the HTML version of this email.]'
    : '';
  const text = `${input.body}${documentNote}\n\n—\n${AGENT_EMAIL_DISCLAIMER}\nOpen the app: ${APP_URL}`;
  return { subject: input.subject, html, text };
}

export interface DealResurfacedEmailInput {
  /** Recipient — the deal's PIC or the user who dropped the deal. */
  email: string;
  companyName: string;
  /** Pipeline stage the deal returns to, e.g. "L1". */
  stage?: string;
  /** e.g. "April 3, 2026". */
  droppedAtLabel?: string;
  /** Original drop reason, shown so the reader has context on why it left. */
  dropReason?: string;
  /** Deep link to the pipeline; defaults to the app root. */
  companyUrl?: string;
}

export function renderDealResurfacedEmail(
  input: Omit<DealResurfacedEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  const subject = `Deal resurfaced: ${input.companyName} is back in the pipeline`;
  const safeName = escapeHtml(input.companyName);
  const rows: Array<{ label: string; value: string }> = [];
  if (input.stage) rows.push({ label: 'Returned to stage', value: input.stage });
  if (input.droppedAtLabel) rows.push({ label: 'Dropped on', value: input.droppedAtLabel });
  if (input.dropReason) rows.push({ label: 'Drop reason', value: input.dropReason });
  const rowsHtml = rows
    .map(
      (r) => `<tr>
        <td style="padding:6px 12px 6px 0; color:#6b7280; font-size:14px; white-space:nowrap; vertical-align:top;">${escapeHtml(r.label)}</td>
        <td style="padding:6px 0; color:#111827; font-size:14px;">${escapeHtml(r.value)}</td>
      </tr>`,
    )
    .join('');
  const ctaUrl = input.companyUrl || APP_URL;

  const html = renderNotificationShell({
    bannerTitle: 'Deal Resurfaced',
    accent: '#0ea5e9',
    accentDark: '#0284c7',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; line-height:1.25;">${safeName} is back in the pipeline</h1>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">
        This deal was dropped with a scheduled resurface date, which has now been
        reached. It has been automatically restored to <strong>active</strong> and
        a note explaining the resurface was added to the deal.
      </p>
      ${rowsHtml ? `<table style="margin:0 0 8px; border-collapse:collapse;">${rowsHtml}</table>` : ''}`,
    ctaUrl,
    ctaLabel: 'Review the deal',
    footer: 'You are receiving this because you dropped this deal or are its PIC.',
  });

  const text = [
    `${input.companyName} is back in the pipeline`,
    '',
    'This deal was dropped with a scheduled resurface date, which has now been',
    'reached. It has been automatically restored to active and a note explaining',
    'the resurface was added to the deal.',
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    `Review the deal: ${ctaUrl}`,
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Company voting
// ---------------------------------------------------------------------------

const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export interface VoteInvitationEmailInput {
  /** Recipient address — a workspace member selected as a voter. */
  email: string;
  recipientName: string;
  companyName: string;
  initiatorName: string;
  /** Pre-formatted absolute deadline, e.g. "5:00 PM on September 5, 2026". */
  deadlineLabel: string;
  /** Deep link straight to the company's Voting tab. */
  voteUrl: string;
  /** Deep link to the company's Company Card (the Overview tab). */
  companyCardUrl?: string;
  /** The Company Card deck, attached so voters can decide from the email. */
  companyCardPptx?: Buffer;
  /** Attachment filename — defaults to a slug of the company name. */
  filename?: string;
}

export function renderVoteInvitationEmail(
  input: Omit<VoteInvitationEmailInput, 'email' | 'companyCardPptx' | 'filename'>,
  opts?: { hasAttachment?: boolean },
): { subject: string; html: string; text: string } {
  const subject = `You're a voter on ${input.companyName}`;
  const rows = [
    { label: 'Company', value: input.companyName },
    { label: 'Initiated by', value: input.initiatorName },
    { label: 'Voting deadline', value: input.deadlineLabel },
  ];

  const html = renderNotificationShell({
    bannerTitle: 'You Have a Vote to Cast',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<p style="margin:0 0 8px; color:#52525b; font-size:15px;">Hey, ${escapeHtml(input.recipientName)},</p>
      <h1 style="margin:0 0 16px; font-size:22px; line-height:1.3;">You have been selected as a voter for ${escapeHtml(input.companyName)}</h1>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">
        Please cast your vote before the deadline. You can save a draft and revise
        it as often as you like — but once you press <strong>Submit</strong> your
        vote is final. Any ballot still in draft when the deadline passes is
        submitted automatically as <strong>INCONCLUSIVE</strong>.
      </p>
      ${kvTable(rows.map((r) => kvRow(r.label, r.value)).join(''))}
      ${sectionLabel('THE COMPANY CARD')}
      <p style="margin:6px 0 0; line-height:1.6; color:#52525b; font-size:14px;">
        ${
          opts?.hasAttachment === false
            ? 'Open the company card in the app for the full picture before you vote.'
            : 'The company card is attached as a PowerPoint deck, so you have the full picture without leaving your inbox.'
        }
        ${
          input.companyCardUrl
            ? `You can also <a href="${escapeHtml(input.companyCardUrl)}" style="color:#2563eb; font-weight:600;">view the company card in Investment Brain</a>, where it stays up to date.`
            : ''
        }
      </p>`,
    ctaUrl: input.voteUrl,
    ctaLabel: 'Cast your vote',
    footer: 'You are receiving this because you were selected as a voter on this company.',
  });

  const text = [
    `You have been selected as a voter for ${input.companyName}`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    'You can save a draft and revise it until you submit. Once submitted, your',
    'vote is final. Anything still in draft at the deadline is submitted',
    'automatically as INCONCLUSIVE.',
    '',
    ...(opts?.hasAttachment === false
      ? []
      : ['The company card is attached to this email as a PowerPoint deck.']),
    ...(input.companyCardUrl
      ? [`View the company card: ${input.companyCardUrl}`]
      : []),
    '',
    `Cast your vote: ${input.voteUrl}`,
  ].join('\n');

  return { subject, html, text };
}

export interface VoteSubmittedEmailInput {
  email: string;
  recipientName: string;
  companyName: string;
  /** Display label of the submitted choice, e.g. "HARD YES". */
  choiceLabel: string;
  deadlineLabel: string;
  voteUrl: string;
}

export function renderVoteSubmittedEmail(
  input: Omit<VoteSubmittedEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  const subject = `Your vote has been submitted for ${input.companyName}`;
  const rows = [
    { label: 'Company', value: input.companyName },
    { label: 'Your vote', value: input.choiceLabel },
    { label: 'Voting closes', value: input.deadlineLabel },
  ];

  const html = renderNotificationShell({
    bannerTitle: 'Vote Submitted',
    accent: '#22c55e',
    accentDark: '#15803d',
    bodyHtml: `<p style="margin:0 0 8px; color:#16a34a; font-weight:700;">✔ Submitted</p>
      <h1 style="margin:0 0 16px; font-size:22px; line-height:1.3;">Your vote has been submitted for ${escapeHtml(input.companyName)}</h1>
      <p style="margin:0 0 16px; line-height:1.6; color:#374151; font-size:15px;">
        Thanks, ${escapeHtml(input.recipientName)}. Your ballot is locked and can no
        longer be edited. If the initiator sends submissions back for revision you
        will be able to change it again.
      </p>
      ${kvTable(rows.map((r) => kvRow(r.label, r.value)).join(''))}`,
    ctaUrl: input.voteUrl,
    ctaLabel: 'View the vote',
    footer: 'You are receiving this because you submitted a vote on this company.',
  });

  const text = [
    `Your vote has been submitted for ${input.companyName}`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    `View the vote: ${input.voteUrl}`,
  ].join('\n');

  return { subject, html, text };
}

export interface VoteRecapRow {
  voterName: string;
  choiceLabel: string;
  /** Plain-text rationale — already flattened from the stored HTML. */
  rationale?: string;
}

export interface VoteRecapEmailInput {
  email: string;
  companyName: string;
  /** e.g. "4–0 FOR". */
  headline: string;
  /** e.g. "4 Proceed". */
  outcomeLabel: string;
  /** Why the round closed. */
  closedReason: 'all_submitted' | 'deadline';
  ballots: VoteRecapRow[];
  voteUrl: string;
}

export function renderVoteRecapEmail(
  input: Omit<VoteRecapEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  const subject = `Voting closed: ${input.companyName} — ${input.headline}`;
  const reason =
    input.closedReason === 'all_submitted'
      ? 'Every voter submitted, so the round closed early.'
      : 'The deadline passed. Any ballot still in draft was submitted automatically as INCONCLUSIVE.';

  const ballotsHtml = input.ballots
    .map(
      (b) => `<tr>
        <td style="padding:12px 12px 12px 0; border-bottom:1px solid #efeff2; color:#111; font-size:15px; font-weight:700; vertical-align:top; white-space:nowrap;">${escapeHtml(b.voterName)}</td>
        <td style="padding:12px 0; border-bottom:1px solid #efeff2; color:#52525b; font-size:14px; vertical-align:top;">
          <div style="font-weight:700; color:#111; margin-bottom:${b.rationale ? '6px' : '0'};">${escapeHtml(b.choiceLabel)}</div>
          ${b.rationale ? `<div style="white-space:pre-wrap; line-height:1.6;">${escapeHtml(b.rationale)}</div>` : ''}
        </td>
      </tr>`,
    )
    .join('');

  const html = renderNotificationShell({
    bannerTitle: 'Voting Results',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `<h1 style="margin:0 0 6px; font-size:22px; line-height:1.3;">${escapeHtml(input.companyName)} — ${escapeHtml(input.headline)}</h1>
      <p style="margin:0 0 16px; color:#6d5ef5; font-weight:700; font-size:15px;">${escapeHtml(input.outcomeLabel)}</p>
      <p style="margin:0 0 8px; line-height:1.6; color:#374151; font-size:15px;">${escapeHtml(reason)}</p>
      ${sectionLabel('REVIEWER FEEDBACK')}
      ${ballotsHtml ? `<table width="100%" style="border-collapse:collapse;">${ballotsHtml}</table>` : '<p style="margin:8px 0 0; color:#a1a1aa; font-size:14px;">No ballots were cast.</p>'}`,
    ctaUrl: input.voteUrl,
    ctaLabel: 'Open the full results',
    footer: 'You are receiving this because you initiated or voted in this round.',
  });

  const text = [
    `${input.companyName} — ${input.headline} (${input.outcomeLabel})`,
    '',
    reason,
    '',
    'Reviewer feedback:',
    ...(input.ballots.length
      ? input.ballots.flatMap((b) => [
          '',
          `${b.voterName} — ${b.choiceLabel}`,
          ...(b.rationale ? [b.rationale] : []),
        ])
      : ['(no ballots were cast)']),
    '',
    `Open the full results: ${input.voteUrl}`,
  ].join('\n');

  return { subject, html, text };
}

export interface FeedbackSubmittedEmailInput {
  /** Fixed recipient — nico.alimin@smma.id — but kept as an input so tests
   * and the caller stay explicit about who's being emailed. */
  email: string;
  submitterName: string;
  submitterEmail: string;
  workspaceName: string;
  title: string;
  message: string;
  /** Present once the companion Jira ticket was filed successfully. */
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}

/** Collapse CR/LF so display names cannot inject email headers via the subject. */
function sanitizeEmailHeaderFragment(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function renderFeedbackSubmittedEmail(
  input: Omit<FeedbackSubmittedEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  const submitterName =
    sanitizeEmailHeaderFragment(input.submitterName) || 'Unknown user';
  const workspaceName =
    sanitizeEmailHeaderFragment(input.workspaceName) || 'Unknown workspace';
  const subject = `${workspaceName} - New Feedback from ${submitterName} Received`;

  const rows = [
    { label: 'From', value: `${input.submitterName} (${input.submitterEmail})` },
    { label: 'Workspace', value: input.workspaceName },
    { label: 'Title', value: input.title },
    ...(input.jiraIssueKey
      ? [
          {
            label: 'Jira ticket',
            value: input.jiraIssueUrl ?? input.jiraIssueKey,
          },
        ]
      : []),
  ];

  const jiraLinkHtml = input.jiraIssueUrl
    ? `<tr>
    <td style="padding:14px 0; border-bottom:1px solid #efeff2; color:#52525b; font-size:15px; vertical-align:top;">Jira ticket</td>
    <td style="padding:14px 0 14px 16px; border-bottom:1px solid #efeff2; color:#111; font-weight:700; font-size:15px; text-align:right; vertical-align:top;">
      <a href="${escapeHtml(input.jiraIssueUrl)}" style="color:#5a4bd6; text-decoration:underline;">${escapeHtml(input.jiraIssueKey || input.jiraIssueUrl)}</a>
    </td>
  </tr>`
    : input.jiraIssueKey
      ? kvRow('Jira ticket', input.jiraIssueKey)
      : '';

  const html = renderNotificationShell({
    bannerTitle: '📝 New Feedback',
    accent: '#6d5ef5',
    accentDark: '#5a4bd6',
    bodyHtml: `${kvTable(
      [
        kvRow('From', `${input.submitterName} (${input.submitterEmail})`),
        kvRow('Workspace', input.workspaceName),
        kvRow('Title', input.title),
        jiraLinkHtml,
      ].join(''),
    )}
      ${sectionLabel('Message')}
      <div style="margin:8px 0 0; padding:16px; background:#f9fafb; border-radius:6px; border:1px solid #e5e7eb; color:#374151; font-size:14px; line-height:1.5;">${escapeHtml(input.message).replace(/\n/g, '<br />')}</div>`,
    ctaUrl: input.jiraIssueUrl,
    ctaLabel: 'View Jira ticket →',
  });

  const text = [
    subject,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    '',
    'Message:',
    input.message,
  ].join('\n');

  return { subject, html, text };
}

export interface ConsentRecordedEmailInput {
  /** Fixed recipient — nico.alimin@smma.id — but kept as an input so tests
   * and the caller stay explicit about who's being emailed. */
  email: string;
  userName: string;
  userEmail: string;
  policyVersion: string;
  /** Pre-formatted "August 27, 2026, 2:42 PM". */
  consentedAtLabel: string;
}

export function renderConsentRecordedEmail(
  input: Omit<ConsentRecordedEmailInput, 'email'>,
): { subject: string; html: string; text: string } {
  const userName = sanitizeEmailHeaderFragment(input.userName) || 'Unknown user';
  const subject = `${userName} accepted the Sync consent screen`;

  const rows = [
    { label: 'User', value: `${input.userName} (${input.userEmail})` },
    { label: 'Policy version', value: input.policyVersion },
    { label: 'Consented at', value: input.consentedAtLabel },
  ];

  const html = renderNotificationShell({
    bannerTitle: '✅ Sync Consent Recorded',
    accent: '#0f7a82',
    accentDark: '#0b5960',
    bodyHtml: kvTable(rows.map((r) => kvRow(r.label, r.value)).join('')),
  });

  const text = [subject, '', ...rows.map((r) => `${r.label}: ${r.value}`)].join('\n');

  return { subject, html, text };
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
   * Send the account-invite email containing a one-time "set your password"
   * link to a user an admin just created via `AuthService.signUp`. Reuses the
   * same reset-token mechanics and `/reset-password` page as the forgot-password
   * flow — the `token` is a row in `reset_password_tokens`.
   */
  async sendAccountInviteEmail(
    input: AccountInviteEmailInput,
  ): Promise<SendEmailResult> {
    const { email, name, token, appUrl } = input;
    if (!email) throw new Error('sendAccountInviteEmail: email is required');
    if (!name) throw new Error('sendAccountInviteEmail: name is required');
    if (!token) throw new Error('sendAccountInviteEmail: token is required');
    if (!appUrl) throw new Error('sendAccountInviteEmail: appUrl is required');

    const ttlMinutes = input.ttlMinutes ?? 7 * 24 * 60;
    const resetUrl = buildResetUrl(token, appUrl);
    const { subject, html, text } = renderAccountInviteEmail({ name, resetUrl, ttlMinutes });

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

  /**
   * Send a company-export email with a comprehensive .xlsx attached. The body
   * carries the company count and filter summary so the message is useful even
   * before opening the workbook. The recipient MUST already be validated
   * against the platform-user whitelist by the caller, same guardrail as
   * sendAgentEmail.
   *
   * NOTE: the agent path now composes everything through the single `send_email`
   * tool + {@link sendComposedEmail}; this single-artifact helper is retained as
   * a reusable email primitive.
   */
  async sendCompanyExcelEmail(
    input: CompanyExcelEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) {
      throw new Error('sendCompanyExcelEmail: email is required');
    }
    if (!input.title) {
      throw new Error('sendCompanyExcelEmail: title is required');
    }
    if (!input.excelBuffer || input.excelBuffer.length === 0) {
      throw new Error('sendCompanyExcelEmail: excelBuffer is required');
    }

    const { subject, html, text } = renderCompanyExcelEmail({
      title: input.title,
      companyCount: input.companyCount,
      filterSummary: input.filterSummary,
    });

    const filename = input.filename ?? `${slugifyTitle(input.title)}.xlsx`;

    return this.attachmentSender({
      to: input.email,
      subject: input.subject ?? subject,
      html,
      text,
      from: buildAgentFromAddress(DEFAULT_FROM_EMAIL),
      attachments: [
        {
          filename,
          content: input.excelBuffer,
          contentType: XLSX_CONTENT_TYPE,
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

  /** A scheduled routine refresh published a new insight version. */
  async sendInsightRefreshedEmail(
    input: InsightRefreshedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendInsightRefreshedEmail: email is required');
    if (!input.insightName) {
      throw new Error('sendInsightRefreshedEmail: insightName is required');
    }
    const { subject, html, text } = renderInsightRefreshedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** A personal to-do's reminder came due. */
  async sendTaskReminderEmail(input: TaskReminderEmailInput): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendTaskReminderEmail: email is required');
    if (!input.taskTitle) throw new Error('sendTaskReminderEmail: taskTitle is required');
    const { subject, html, text } = renderTaskReminderEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** A company auto-created from a banker email was assigned to the recipient. */
  async sendCompanyAssignedEmail(
    input: CompanyAssignedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendCompanyAssignedEmail: email is required');
    if (!input.recipientName) {
      throw new Error('sendCompanyAssignedEmail: recipientName is required');
    }
    if (!input.companyName) {
      throw new Error('sendCompanyAssignedEmail: companyName is required');
    }
    const { subject, html, text } = renderCompanyAssignedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /**
   * Tell a mailbox custodian that a PDF crawled from their email landed in
   * Brain. Fired only for the email (MBOX) ingest path — manual Smart Files
   * uploads never notify, since the uploader added the file themselves.
   */
  async sendEmailPdfIngestedEmail(
    input: EmailPdfIngestedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendEmailPdfIngestedEmail: email is required');
    if (!input.fileName) {
      throw new Error('sendEmailPdfIngestedEmail: fileName is required');
    }
    if (!input.workspaceName) {
      throw new Error('sendEmailPdfIngestedEmail: workspaceName is required');
    }
    const { subject, html, text } = renderEmailPdfIngestedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** A dropped deal reached its scheduled resurface date and is active again. */
  async sendDealResurfacedEmail(
    input: DealResurfacedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendDealResurfacedEmail: email is required');
    if (!input.companyName) {
      throw new Error('sendDealResurfacedEmail: companyName is required');
    }
    const { subject, html, text } = renderDealResurfacedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Notify the product owner (nico.alimin@smma.id) that feedback was submitted. */
  async sendFeedbackSubmittedEmail(
    input: FeedbackSubmittedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendFeedbackSubmittedEmail: email is required');
    if (!input.title) throw new Error('sendFeedbackSubmittedEmail: title is required');
    if (!input.message) throw new Error('sendFeedbackSubmittedEmail: message is required');
    const { subject, html, text } = renderFeedbackSubmittedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Notify the product owner (nico.alimin@smma.id) that a user accepted the Sync consent screen. */
  async sendConsentRecordedEmail(
    input: ConsentRecordedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendConsentRecordedEmail: email is required');
    if (!input.userEmail) {
      throw new Error('sendConsentRecordedEmail: userEmail is required');
    }
    const { subject, html, text } = renderConsentRecordedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /**
   * Invite a selected voter to a company vote, with the Company Card deck
   * attached as a .pptx so they can decide without opening the app.
   *
   * Uses the raw/attachment SES path when a deck is supplied and degrades to
   * the plain path when the card could not be built — a missing attachment must
   * never cost someone their invitation.
   */
  async sendVoteInvitationEmail(
    input: VoteInvitationEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendVoteInvitationEmail: email is required');
    if (!input.companyName) {
      throw new Error('sendVoteInvitationEmail: companyName is required');
    }
    if (!input.voteUrl) throw new Error('sendVoteInvitationEmail: voteUrl is required');

    const hasAttachment = Boolean(
      input.companyCardPptx && input.companyCardPptx.length > 0,
    );
    const { subject, html, text } = renderVoteInvitationEmail(input, { hasAttachment });
    if (!hasAttachment) {
      // The deck could not be built. The in-app link is then the only route to
      // the card, so the body must not promise an attachment that isn't there.
      return this.sender({ to: input.email, subject, html, text });
    }

    return this.attachmentSender({
      to: input.email,
      subject,
      html,
      text,
      attachments: [
        {
          filename:
            input.filename ?? `${slugifyTitle(`${input.companyName} company card`)}.pptx`,
          content: input.companyCardPptx,
          contentType: PPTX_CONTENT_TYPE,
        },
      ],
    });
  }

  /** Confirm to a voter that their ballot is locked in. */
  async sendVoteSubmittedEmail(
    input: VoteSubmittedEmailInput,
  ): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendVoteSubmittedEmail: email is required');
    if (!input.companyName) {
      throw new Error('sendVoteSubmittedEmail: companyName is required');
    }
    const { subject, html, text } = renderVoteSubmittedEmail(input);
    return this.sender({ to: input.email, subject, html, text });
  }

  /** Recap a closed round to the initiator and every voter. */
  async sendVoteRecapEmail(input: VoteRecapEmailInput): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendVoteRecapEmail: email is required');
    if (!input.companyName) {
      throw new Error('sendVoteRecapEmail: companyName is required');
    }
    const { subject, html, text } = renderVoteRecapEmail(input);
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

  /**
   * Send a single agent-composed email that carries a free-form body plus any
   * number of attachments (e.g. a company Excel workbook and a research PDF)
   * together. This is what lets the `send_email` tool deliver everything the
   * agent assembled in ONE message instead of several disjointed emails.
   *
   * Uses the same branded agent shell + "Investment Brain" sender as
   * {@link sendAgentEmail}. When there are no attachments it degrades to the
   * plain (non-raw) SES path; otherwise it uses the raw/attachment path. The
   * recipient MUST already be validated against the platform-user whitelist by
   * the caller.
   */
  async sendComposedEmail(input: ComposedEmailInput): Promise<SendEmailResult> {
    if (!input.email) throw new Error('sendComposedEmail: email is required');
    if (!input.subject) throw new Error('sendComposedEmail: subject is required');
    if (!input.body) throw new Error('sendComposedEmail: body is required');

    const { subject, html, text } = renderAgentEmail({
      subject: input.subject,
      body: input.body,
      documentHtml: input.documentHtml,
    });
    const from = buildAgentFromAddress(DEFAULT_FROM_EMAIL);
    const attachments = input.attachments ?? [];

    if (attachments.length === 0) {
      return this.sender({ to: input.email, subject, html, text, from });
    }

    return this.attachmentSender({
      to: input.email,
      subject,
      html,
      text,
      from,
      attachments,
    });
  }

}
