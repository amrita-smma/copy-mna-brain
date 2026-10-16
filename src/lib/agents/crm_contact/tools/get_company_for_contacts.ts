import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { CompanyRepository } from '@/lib/repositories';
import { companyDisplayName } from '@/lib/companyDisplay';
import { logger } from '../../logger';
import { domainFromWebsite } from '../constants';

/** How many CRM contacts to show the agent, so it can merge rather than duplicate. */
const CRM_CONTACTS_SHOWN = 25;

function line(label: string, value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? `- **${label}:** ${v}` : null;
}

const MATCH_NOTE = {
  stored: 'linked to this company',
  domain: 'matched on the website domain — it will be linked when you save',
  name: 'matched on the company name — it will be linked when you save',
} as const;

export const getCompanyForContacts = tool(
  async ({ company_id }: { company_id: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_company_for_contacts(${company_id})`);

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const company = await new CompanyRepository(db, workspaceId).findByIdOrNull(company_id);
      if (!company) {
        return `**Error:** No company with id ${company_id} is visible in this workspace. Do not look anyone up — stop and report this.`;
      }
      const { companyContactDiscoveryService } = createContainer(db, workspaceId);
      const state = await companyContactDiscoveryService.getState(company_id, CRM_CONTACTS_SHOWN);

      const name = companyDisplayName(company, 'Unnamed company');
      const domain = domainFromWebsite(company.website);
      const facts = [
        line('Name', name),
        line('Website', company.website),
        line('Domain', domain),
        line('Country', company.geography),
        line('Segment', company.segment),
        line('What it does', company.company_focus ?? company.segment_related_offerings),
        line('Ownership', company.ownership),
      ]
        .filter(Boolean)
        .join('\n');

      const crm = state.employer
        ? `CRM firm: **${state.employer.name}** (${MATCH_NOTE[state.employer.matchedBy]}).`
        : 'This company is not in the CRM yet — your save will create its firm record.';
      const existing =
        state.contacts.length === 0
          ? '_None yet._'
          : state.contacts
              .map(
                (c) =>
                  `- ${c.name}${c.title ? ` — ${c.title}` : ''}${c.email ? ` <${c.email}>` : ''}`,
              )
              .join('\n') +
            (state.totalContacts > state.contacts.length
              ? `\n- …and ${state.totalContacts - state.contacts.length} more`
              : '');

      logger.debug(`✓ get_company_for_contacts: ${name}, ${state.totalContacts} in CRM`);

      return `## Company — ${name}

${facts}

### In the CRM
${crm}

${existing}

Saving someone already listed here merges into their record (filling only empty fields) rather than adding a duplicate — re-confirm they still work there before including them.${
        domain
          ? ''
          : '\n\nThere is no usable website on file: establish the company\'s own site first, so you can tell it apart from namesakes.'
      }`;
    } catch (error) {
      logger.error(`get_company_for_contacts error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: 'get_company_for_contacts',
    description: `Read one pipeline company — name, website, country, what it does — and the contacts the CRM already holds for it.

Call this FIRST, before any web search. The name, website and country are what you confirm every web result against; the CRM contacts are who you must not duplicate.

Args:
    company_id: The company's id, given to you in the instruction.

Returns:
    Markdown — the company's identity, its CRM firm (if any) and that firm's contacts.`,
    schema: z.object({
      company_id: z.string().describe('The company id named in your instruction.'),
    }),
  },
);
