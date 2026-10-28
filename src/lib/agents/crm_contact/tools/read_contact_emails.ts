import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { ContactNotFoundError } from '@/lib/services/crmContactEnrichmentService';
import { isoDay } from '@/lib/crm/displayText';
import { logger } from '../../logger';
import { runtimeViewer } from '../../runtimeViewer';

/** Notes read per run: the newest ones with a business summary. */
export const MAX_EMAIL_NOTES = 50;

/**
 * read_contact_emails — the email context "Get Full Profile" starts from: the
 * contact's shared relationship overview (if one was generated), the deal
 * roles inferred from their emails, and the AI notes on those emails. One
 * bounded read through ContactConversationService.
 *
 * Email notes are private to the people on each email. An AI Workforce run
 * may use the full context (getConversationForWorkforce), but this tool's
 * output is redacted from the run's trace (traceMapper PRIVATE_OUTPUT_TOOLS):
 * only the run's report, and the fields it writes, are shared. Anywhere else
 * it reads only the notes the user may see (none without a user).
 */
export const readContactEmails = tool(
  async ({ correspondent_id }: { correspondent_id: string }, runtime?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: read_contact_emails(${correspondent_id})`);
    try {
      const viewer = runtimeViewer(runtime);
      const workspaceId = await getActiveWorkspaceId();
      const { contactConversationService } = createContainer(createDb(), workspaceId);
      // Outside a Workforce run: only the notes this user may see ("", no user: none).
      const conversation = viewer.workforce
        ? await contactConversationService.getConversationForWorkforce(correspondent_id, {
            limit: MAX_EMAIL_NOTES,
          })
        : await contactConversationService.getConversation(correspondent_id, viewer.userId ?? '', {
            limit: MAX_EMAIL_NOTES,
          });

      const overview = conversation.overview.text?.trim()
        ? `### Relationship overview (the last AI summary of their emails${
            conversation.overview.generatedAt
              ? `, ${isoDay(conversation.overview.generatedAt) ?? conversation.overview.generatedAt}`
              : ''
          })\n${conversation.overview.text.trim()}\n\n`
        : '';

      if (conversation.notes.length === 0) {
        return `${overview}${
          conversation.hasSyncedData
            ? 'No email notes with a business summary are available for this contact. Rely on the record and the web.'
            : 'This workspace has no synced email, so there is no email context for this contact. Rely on the record and the web.'
        }`;
      }

      const roleLines = conversation.roles.roles.map(
        (r) => `- ${r.label} (${r.confidence} confidence, ${r.emailCount} email(s))`,
      );
      const noteLines = conversation.notes.map((n) => {
        const parts = [`- ${isoDay(n.sentAt) ?? n.sentAt} · ${n.direction === 'inbound' ? 'from their side' : 'from us'}: ${n.summary}`];
        if (n.keyPoints.length > 0) parts.push(`  Key points: ${n.keyPoints.join('; ')}`);
        if (n.nextStep) parts.push(`  Next step: ${n.nextStep}`);
        return parts.join('\n');
      });

      return `${overview}## Email evidence — ${conversation.notes.length} most recent note(s)${
        conversation.nextCursor ? ` (older notes exist; these are the newest ${MAX_EMAIL_NOTES})` : ''
      }

Each note paraphrases one email between this contact and our team. A note "from their side" may have been written by a colleague of theirs on the thread; a note describes several people. Attribute a fact to this contact only when the note says it about them.

### Deal roles inferred from their emails
${roleLines.length > 0 ? roleLines.join('\n') : '- none recorded'}${
        conversation.overview.roleSummary
          ? `\nAcross their emails: ${conversation.overview.roleSummary}`
          : ''
      }${conversation.roles.evidence ? `\nEvidence: ${conversation.roles.evidence}` : ''}

### Notes, newest first
${noteLines.join('\n')}

Cite a note by its date and side when you write a value, e.g. "email 2026-10-12 from their side". These notes are private: never quote or paraphrase them in narrate_step or anywhere but the final report's field values and citations. A meeting counts only as held or planned: never carry its date, time, place or link into the report.`;
    } catch (error) {
      if (error instanceof ContactNotFoundError) {
        return `**Error:** no CRM contact ${correspondent_id} in this workspace.`;
      }
      logger.error(`read_contact_emails error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'read_contact_emails',
    description: `Read what our synced email shows about one CRM contact: the last relationship overview (if any), the deal roles inferred from their emails, and the AI notes on those emails (newest ${MAX_EMAIL_NOTES}, each a paraphrase with its date and which side sent it).

Call it right after get_crm_contact and before any web search: the emails are this exact person, so they anchor identity (name, firm, desk) for the searches, and a value they state is evidence in its own right. The notes are private — never quote them in narrate_step.

Args:
    correspondent_id: The contact's id, given to you in the instruction.

Returns:
    Markdown — roles, then notes newest first.`,
    schema: z.object({
      correspondent_id: z.string().describe('The CRM contact id named in your instruction.'),
    }),
  },
);
