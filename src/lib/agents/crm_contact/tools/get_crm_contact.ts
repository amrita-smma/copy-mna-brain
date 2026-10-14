import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import {
  CorrespondentRepository,
  EmployerRepository,
} from '@/lib/repositories';
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
      const firmName = employer?.name ?? 'an unknown firm';

      const missing = missingProfileFields(contact);
      const filled = CRM_CONTACT_WRITABLE_FIELDS.filter(
        (f) => !missing.includes(f),
      );

      const knownLines = [
        `- **Name:** ${contact.name}  _(complete or correct it for the same person only — never rename to someone else)_`,
        `- **Firm:** ${firmName}${employer?.industry ? ` — ${employer.industry}` : ''}`,
        `- **Email:** ${contact.email || '_(none on file)_'}  _(you may not change this)_`,
        ...filled.map((f) => `- **${FIELD_LABELS[f]}:** ${contact[f]}`),
      ].join('\n');

      const missingLine =
        missing.length === 0
          ? '_Nothing is empty — this record is already complete. Only write if you can show a stored value is out of date._'
          : missing.map((f) => `- ${FIELD_LABELS[f]} (\`${f}\`)`).join('\n');

      logger.debug(
        `✓ get_crm_contact: ${contact.name} @ ${firmName}, ${missing.length} field(s) empty`,
      );

      return `## CRM contact — ${contact.name} @ ${firmName}

### Already on file
${knownLines}

### Empty — what this run is for
${missingLine}

Confirm that the ${contact.name} you find on the web is the one at ${firmName} before writing anything.`;
    } catch (error) {
      logger.error(`get_crm_contact error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'get_crm_contact',
    description: `Read one CRM contact (correspondent) as the CRM currently holds them, and find out which profile fields are empty.

Call this FIRST, before any web search. It returns the person's name and firm — which together are what you must confirm a web result against — plus the fields already filled (leave those alone) and the fields that are empty (those are the job).

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
