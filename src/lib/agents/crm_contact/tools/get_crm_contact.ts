import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  CorrespondentRepository,
  EmployerRepository,
} from '@/lib/repositories';
import { createContainer } from '@/lib/services/container';
import { decodeHtmlEntities, isoDay, NO_INTERACTION_DATA } from '@/lib/crm/displayText';
import type { ContactInsights } from '@/lib/services/contactInsightsService';
import { logger } from '../../logger';
import {
  CRM_CONTACT_WRITABLE_FIELDS,
  missingProfileFields,
  type CrmContactWritableField,
} from '../constants';

/** Human label per writable column, for the brief the model reads. */
const FIELD_LABELS: Record<CrmContactWritableField, string> = {
  title: 'Title',
  phone: 'Phone',
  type: 'Contact type',
  department: 'Department (desk)',
  specialization: 'Specialization',
  seniority: 'Seniority',
  coverage_region: 'Coverage region',
  linkedin_url: 'LinkedIn URL',
  bio: 'Bio',
};

/**
 * This person's relationship with our team (MB-859) — context for the run,
 * never profile data to write. Missing data reads "no data", never 0.
 */
function renderRelationship(insights: ContactInsights | null): string {
  const lines = [
    '### Relationship with our team',
    '_Context only — not a profile field. Never write any of this into the record._',
  ];
  const s = insights?.interactions;
  if (!insights || !s.hasSyncedData) {
    lines.push(`- Interactions: ${NO_INTERACTION_DATA}`);
  } else if (s.team.length === 0) {
    lines.push('- No email with anyone on our team is on record.');
  } else {
    lines.push(
      `- ${s.teamMemberCount} team member(s) in touch: ${s.team
        .slice(0, 3)
        .map(
          (t) =>
            `${t.name ?? t.email ?? t.userId} (${t.emailsFromUs + t.emailsFromThem} email(s))`,
        )
        .join(', ')}${s.team.length > 3 ? `, +${s.team.length - 3} more` : ''}`,
      `- Totals: ${s.totalEmailsFromUs} email(s) from us, ${s.totalEmailsFromThem} from them`,
      `- Last contact: ${isoDay(s.lastContactAt) ?? 'none recorded'}`,
    );
  }
  if (insights) {
    const card = insights.scorecard;
    if (!card.hasDealLinks && insights.deals.length === 0) {
      lines.push('- Deals: no deal links recorded');
    } else {
      const names = insights.deals
        .map((d) => `${d.companyName} (${d.role === 'source' ? 'brought' : 'involved'}, ${d.stageLabel})`)
        .join(', ');
      lines.push(
        `- Deals: brought ${card.dealsBrought}, involved ${card.dealsInvolved}, reached L1 ${card.reachedL1}${names ? ` — ${names}` : ''}`,
      );
    }
  } else {
    lines.push('- Deals: no data');
  }
  return lines.join('\n');
}

export const getCrmContact = tool(
  async ({ correspondent_id }: { correspondent_id: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_crm_contact(${correspondent_id})`);

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const contact = await new CorrespondentRepository(db).findById(
        correspondent_id,
        workspaceId,
      );
      if (!contact) {
        return `**Error:** No CRM contact with id ${correspondent_id} is visible in this workspace. Do not look anyone up — stop and report this.`;
      }

      const employer = await new EmployerRepository(db).findById(
        contact.employer_id,
      );
      // Stored CRM text can carry ingest's HTML entities (`&amp;`): the model
      // must search the web for the real name, not the escaped one.
      const firmName = decodeHtmlEntities(employer?.name) ?? 'an unknown firm';
      const contactName = decodeHtmlEntities(contact.name);
      const industry = decodeHtmlEntities(employer?.industry);

      const missing = missingProfileFields(contact);
      const filled = CRM_CONTACT_WRITABLE_FIELDS.filter(
        (f) => !missing.includes(f),
      );

      const knownLines = [
        `- **Name:** ${contactName}  _(complete or correct it for the same person only — never rename to someone else)_`,
        `- **Firm:** ${firmName}${industry ? ` — ${industry}` : ''}`,
        `- **Email:** ${contact.email || '_(none on file)_'}  _(you may not change this)_`,
        ...filled.map((f) => `- **${FIELD_LABELS[f]}:** ${decodeHtmlEntities(contact[f])}`),
      ].join('\n');

      const missingLine =
        missing.length === 0
          ? '_Nothing is empty — this record is already complete. Only write if you can show a stored value is out of date, or if your instruction marks this run a REFRESH (then rewrite the bio)._'
          : missing.map((f) => `- ${FIELD_LABELS[f]} (\`${f}\`)`).join('\n');

      // Best-effort: a failed insights read must not cost the run its brief.
      let insights: ContactInsights | null = null;
      try {
        insights = await createContainer(db, workspaceId).contactInsightsService.getContactInsights(
          contact.id,
        );
      } catch (err) {
        logger.error(`get_crm_contact insights error: ${(err as Error).message}`);
      }

      logger.debug(
        `✓ get_crm_contact: ${contactName} @ ${firmName}, ${missing.length} field(s) empty`,
      );

      return `## CRM contact — ${contactName} @ ${firmName}

### Already on file
${knownLines}

### Empty — what this run is for
${missingLine}

Confirm that the ${contactName} you find on the web is the one at ${firmName} before writing anything.

${renderRelationship(insights)}`;
    } catch (error) {
      logger.error(`get_crm_contact error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'get_crm_contact',
    description: `Read one CRM contact (correspondent) as the CRM currently holds them, and find out which profile fields are empty.

Call this FIRST, before any web search. It returns the person's name and firm — which together are what you must confirm a web result against — plus the fields already filled (leave those alone) and the fields that are empty (those are the job). It ends with the person's relationship with our team (who emails / meets them, last contact, deals) — context, not data to write.

Args:
    correspondent_id: The contact's id, given to you in the instruction.

Returns:
    Markdown — what is on file, and what is missing.`,
    schema: z.object({
      correspondent_id: z
        .string()
        .describe('The CRM contact id named in your instruction.'),
    }),
  },
);
