import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { UserRepository } from '@/lib/repositories';
import { EmailService } from '@/lib/services/emailService';

/**
 * send_email — send a free-form, agent-composed email.
 *
 * Recipients are STRICTLY limited to a whitelist: addresses that belong to a
 * registered platform user (the `users` table). The model supplies the
 * recipient list, subject, and body, but any address that is not a known
 * platform user is rejected and never emailed — so the tool cannot be coerced
 * into mailing arbitrary third parties (exfiltration / spam guardrail).
 *
 * Available to both the copilot chat and the workforce agent.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AllowedRecipient {
  email: string;
  name: string;
}

export const sendEmailTool = tool(
  async (args: { to: string[]; subject: string; body: string }) => {
    logger.debug(
      `🔧 TOOL CALLED: send_email(to=[${(args.to ?? []).join(', ')}], subject='${args.subject ?? ''}')`,
    );

    const subject = args.subject?.trim();
    const body = args.body?.trim();
    if (!subject) return '**Error:** subject is required.';
    if (!body) return '**Error:** body is required.';

    // Normalize + de-duplicate the requested recipients (case-insensitive).
    const requested = Array.from(
      new Set((args.to ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    );
    if (requested.length === 0) {
      return '**Error:** at least one recipient is required in `to`.';
    }

    const malformed = requested.filter((e) => !EMAIL_RE.test(e));
    if (malformed.length > 0) {
      return `**Error:** malformed email address(es): ${malformed.join(', ')}.`;
    }

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

      const recipients: AllowedRecipient[] = [];
      const rejected: string[] = [];
      for (const e of requested) {
        const match = allowed.get(e);
        if (match) recipients.push(match);
        else rejected.push(e);
      }

      if (recipients.length === 0) {
        return `**Error:** none of the requested recipients are registered platform users, so nothing was sent. Emails can only be sent to users that exist on the platform. Rejected: ${rejected.join(', ')}.`;
      }

      const emailService = new EmailService();
      const sent: string[] = [];
      const failed: string[] = [];
      for (const r of recipients) {
        try {
          const { messageId } = await emailService.sendAgentEmail({
            email: r.email,
            subject,
            body,
          });
          sent.push(r.email);
          logger.info(`📧 send_email → ${r.email} (messageId=${messageId || 'n/a'})`);
        } catch (err) {
          failed.push(r.email);
          logger.error(`send_email to ${r.email} failed: ${(err as Error).message}`);
        }
      }

      const parts: string[] = [];
      if (sent.length > 0) {
        parts.push(`Sent to ${sent.length} platform user(s): ${sent.join(', ')}.`);
      }
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
    description: `Send a free-form email to one or more platform users. You compose the subject and body and name the recipient(s).

IMPORTANT — recipients are restricted to a whitelist: only email addresses that belong to a registered user of this platform (the users table) can be emailed. Any address that is not a known platform user is silently skipped and reported back; the email is never delivered to non-platform addresses. Do NOT use this tool to email customers, bankers, or any external party — it only reaches internal platform users.

Use this when the user asks you to email a colleague/teammate something specific (a note, a heads-up, a summary in prose). For emailing the signed-in user a formatted research PDF, use email_research_summary instead.

Args:
    to: Required. One or more recipient email addresses. Each must belong to a registered platform user, or it is rejected.
    subject: Required. The email subject line.
    body: Required. The plain-text email body (newlines are preserved). Markdown is NOT rendered — write plain prose.

Returns:
    A confirmation string listing who it was sent to and which addresses were skipped (non-platform), or an error string starting with **Error:**.`,
    schema: z.object({
      to: z
        .array(z.string())
        .min(1)
        .describe('Recipient email addresses — each must be a registered platform user.'),
      subject: z.string().min(1).max(200).describe('Email subject line.'),
      body: z.string().min(1).max(5000).describe('Plain-text email body.'),
    }),
  },
);
