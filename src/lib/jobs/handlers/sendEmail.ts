import { EmailService } from '@/lib/services/emailService';

export const SEND_EMAIL_TIMEOUT_SECONDS = 30;

/**
 * Discriminated union of every email kind the `send-email` queue handler can
 * produce. Add a new variant when you add a new transactional email — the
 * `switch` below is exhaustive, so TypeScript will flag any missing branch.
 */
export type SendEmailPayload =
  | {
      kind: 'forgot_password';
      to: string;
      token: string;
      appUrl: string;
      ttlMinutes?: number;
    }
  | {
      kind: 'task_completed';
      to: string;
      taskName: string;
      taskUrl?: string;
      finishedAtLabel?: string;
      summaryRows?: Array<{ label: string; value: string; highlight?: boolean }>;
      resultRows?: Array<{ label: string; value: string; highlight?: boolean }>;
      summary?: string;
    }
  | {
      kind: 'task_waiting_approval';
      to: string;
      action: string;
      taskName?: string;
      taskUrl?: string;
      company?: string;
      proposedAction?: string;
      reason?: string;
      changeField?: string;
      beforeValue?: string;
      afterValue?: string;
    }
  | {
      kind: 'task_failed';
      to: string;
      taskName: string;
      reason?: string;
      cancelled?: boolean;
      taskUrl?: string;
    }
  | {
      kind: 'task_progress';
      to: string;
      taskName: string;
      progress: string;
      headline?: string;
      taskUrl?: string;
    }
  | {
      kind: 'task_insight';
      to: string;
      companyName: string;
      level: string;
      detail?: string;
      confidencePct?: number;
      taskUrl?: string;
    }
  | {
      kind: 'company_assigned';
      to: string;
      recipientName: string;
      companyName: string;
      bankerSource?: string;
      companyUrl?: string;
    }
  | {
      kind: 'deal_resurfaced';
      to: string;
      companyName: string;
      stage?: string;
      droppedAtLabel?: string;
      dropReason?: string;
      companyUrl?: string;
    };

export interface SendEmailJobResult {
  kind: SendEmailPayload['kind'];
  to: string;
  messageId: string;
}

/**
 * Generic transactional email handler. Constructs the right template based on
 * the `kind` discriminator and delegates the actual SES call to `EmailService`.
 *
 * Invoked by the `send-email` queue consumer route with the queue message as
 * its payload. Intentionally tiny: payload validation + dispatch. Template
 * rendering lives in EmailService so it can be unit-tested in isolation.
 */
export async function runSendEmail(
  payload: SendEmailPayload,
  _deps: { emailService?: EmailService } = {},
): Promise<SendEmailJobResult> {
  const emailService = _deps.emailService ?? new EmailService();

  if (!payload || typeof payload !== 'object') {
    throw new Error('send_email: invalid payload');
  }
  if (!payload.to) throw new Error('send_email: `to` is required');

  switch (payload.kind) {
    case 'forgot_password': {
      if (!payload.token) {
        throw new Error('send_email[forgot_password]: `token` is required');
      }
      if (!payload.appUrl) {
        throw new Error('send_email[forgot_password]: `appUrl` is required');
      }
      const { messageId } = await emailService.sendForgotPasswordEmail({
        email: payload.to,
        token: payload.token,
        appUrl: payload.appUrl,
        ttlMinutes: payload.ttlMinutes,
      });
      return { kind: 'forgot_password', to: payload.to, messageId };
    }
    case 'task_completed': {
      const { messageId } = await emailService.sendTaskCompletedEmail({
        email: payload.to,
        taskName: payload.taskName,
        taskUrl: payload.taskUrl,
        finishedAtLabel: payload.finishedAtLabel,
        summaryRows: payload.summaryRows,
        resultRows: payload.resultRows,
        summary: payload.summary,
      });
      return { kind: 'task_completed', to: payload.to, messageId };
    }
    case 'task_waiting_approval': {
      const { messageId } = await emailService.sendTaskWaitingApprovalEmail({
        email: payload.to,
        action: payload.action,
        taskName: payload.taskName,
        taskUrl: payload.taskUrl,
        company: payload.company,
        proposedAction: payload.proposedAction,
        reason: payload.reason,
        changeField: payload.changeField,
        beforeValue: payload.beforeValue,
        afterValue: payload.afterValue,
      });
      return { kind: 'task_waiting_approval', to: payload.to, messageId };
    }
    case 'task_failed': {
      const { messageId } = await emailService.sendTaskFailedEmail({
        email: payload.to,
        taskName: payload.taskName,
        reason: payload.reason,
        cancelled: payload.cancelled,
        taskUrl: payload.taskUrl,
      });
      return { kind: 'task_failed', to: payload.to, messageId };
    }
    case 'task_progress': {
      const { messageId } = await emailService.sendTaskProgressEmail({
        email: payload.to,
        taskName: payload.taskName,
        progress: payload.progress,
        headline: payload.headline,
        taskUrl: payload.taskUrl,
      });
      return { kind: 'task_progress', to: payload.to, messageId };
    }
    case 'task_insight': {
      const { messageId } = await emailService.sendTaskInsightEmail({
        email: payload.to,
        companyName: payload.companyName,
        level: payload.level,
        detail: payload.detail,
        confidencePct: payload.confidencePct,
        taskUrl: payload.taskUrl,
      });
      return { kind: 'task_insight', to: payload.to, messageId };
    }
    case 'company_assigned': {
      if (!payload.recipientName) {
        throw new Error('send_email[company_assigned]: `recipientName` is required');
      }
      if (!payload.companyName) {
        throw new Error('send_email[company_assigned]: `companyName` is required');
      }
      const { messageId } = await emailService.sendCompanyAssignedEmail({
        email: payload.to,
        recipientName: payload.recipientName,
        companyName: payload.companyName,
        bankerSource: payload.bankerSource,
        companyUrl: payload.companyUrl,
      });
      return { kind: 'company_assigned', to: payload.to, messageId };
    }
    case 'deal_resurfaced': {
      if (!payload.companyName) {
        throw new Error('send_email[deal_resurfaced]: `companyName` is required');
      }
      const { messageId } = await emailService.sendDealResurfacedEmail({
        email: payload.to,
        companyName: payload.companyName,
        stage: payload.stage,
        droppedAtLabel: payload.droppedAtLabel,
        dropReason: payload.dropReason,
        companyUrl: payload.companyUrl,
      });
      return { kind: 'deal_resurfaced', to: payload.to, messageId };
    }
    default: {
      // Exhaustiveness check — adding a new `kind` without a case here is a
      // compile-time error.
      const _exhaustive: never = payload;
      throw new Error(
        `send_email: unsupported kind ${String((_exhaustive as { kind?: unknown }).kind)}`,
      );
    }
  }
}
