import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { CompanyRepository } from '@/lib/repositories';
import { companyDisplayName } from '@/lib/companyDisplay';
import {
  enrichPerson,
  findPhone,
  getTregApiKey,
  type TregPerson,
  type TregPersonQuery,
} from '@/lib/treg';
import { logger } from '../../logger';
import { domainFromWebsite } from '../constants';

function absoluteUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `- **${label}:** ${String(value)}`;
}

function renderPerson(person: TregPerson): string {
  const company = person.company ?? {};
  return [
    line('Name', person.full_name),
    line('Title', person.title),
    line('Seniority', person.seniority),
    line('Department', person.department),
    line('Based in', person.location ?? person.country),
    line('LinkedIn URL', absoluteUrl(person.linkedin_url)),
    line('Company', company.name),
    line('Company website', company.website_url ?? person.company_domain),
  ]
    .filter(Boolean)
    .join('\n');
}

function sourceString(endpoint: string, servedBy: string | null, callId: string | null): string {
  return `treg.to ${endpoint} via ${servedBy ?? 'unknown provider'}${callId ? ` (call ${callId})` : ''}`;
}

/** Never throws — a phone failure must not cost the agent the profile. */
async function phoneSection(query: TregPersonQuery, name: string): Promise<string> {
  try {
    const { phone, verdict, servedBy, callId } = await findPhone(query);
    if (!phone) return `### Phone\nNo phone number found for ${name}. Leave phone empty unless the company publishes one.`;
    if (verdict === 'dead') return `### Phone\n- **Phone:** ${phone}\n- **Line check:** dead — do not save this number.`;
    return `### Phone
- **Phone:** ${phone}
- **Line check:** ${verdict ?? 'not checked'}

Save it only if the profile above is ${name} at this company. Cite \`${sourceString('people.phone.find', servedBy, callId)}\`.`;
  } catch (error) {
    logger.warn(`enrich_company_contact phone lookup failed: ${(error as Error).message}`);
    return `### Phone\nPhone lookup failed (${(error as Error).message}). Leave phone empty unless the company publishes one.`;
  }
}

export const enrichCompanyContactSchema = z.object({
  company_id: z.string().describe('The company id named in your instruction.'),
  full_name: z.string().trim().min(2).max(200).describe('The person\'s full name, as a source you trust gives it.'),
  linkedin_url: z
    .string()
    .trim()
    .url()
    .max(300)
    .optional()
    .describe('Their LinkedIn profile URL, when you have one — the strongest identifier.'),
  company_domain: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('The company\'s website domain, e.g. "acme.co.id". Defaults to the website on file.'),
  with_phone: z
    .boolean()
    .optional()
    .describe('Also look up a phone number (billed separately). Only for people you will save.'),
});

export type EnrichCompanyContactInput = z.infer<typeof enrichCompanyContactSchema>;

export const enrichCompanyContact = tool(
  async ({ company_id, full_name, linkedin_url, company_domain, with_phone }: EnrichCompanyContactInput) => {
    logger.debug(`🔧 TOOL CALLED: enrich_company_contact(${company_id}, ${full_name})`);

    if (!getTregApiKey()) {
      logger.warn('TREG_API_KEY not set');
      return 'Contact enrichment is not available (TREG_API_KEY is not set). Continue with web_search.';
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const company = await new CompanyRepository(db, workspaceId).findByIdOrNull(company_id);
      if (!company) {
        return `**Error:** No company with id ${company_id} is visible in this workspace. Stop and report this.`;
      }
      const companyName = companyDisplayName(company, 'this company');

      const query: TregPersonQuery = {
        full_name,
        linkedin_url,
        domain: company_domain ?? domainFromWebsite(company.website),
      };
      const result = await enrichPerson(query);
      const sentWith = Object.entries(query)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');

      const phone = with_phone
        ? await phoneSection(
            {
              ...query,
              linkedin_url: query.linkedin_url ?? absoluteUrl(result.person?.linkedin_url) ?? undefined,
            },
            full_name,
          )
        : null;
      const withPhone = (text: string) => (phone ? `${text}\n\n${phone}` : text);

      if (!result.person) {
        return withPhone(
          `No enrichment record found for ${full_name} @ ${companyName} (matched on: ${sentWith}). A miss says nothing about whether they work there — rely on the sources you already have.`,
        );
      }

      const source = sourceString('people.enrich', result.servedBy, result.callId);
      logger.debug(
        `✓ enrich_company_contact: hit for ${full_name} via ${result.servedBy} ($${(result.costMicro / 1e6).toFixed(4)})`,
      );

      return withPhone(`## Enrichment record — ${result.person.full_name}

Matched on: ${sentWith}.

${renderPerson(result.person)}

### Before you use this
- A **data-vendor record**, not the company's own page. The company must be ${companyName}; a different employer means the record is stale or a namesake — do not save from it.
- Good for a current title and a LinkedIn URL. When you save a value from it, list \`${source}\` in that person's sources${result.person.linkedin_url ? `, alongside ${absoluteUrl(result.person.linkedin_url)}` : ''}.`);
    } catch (error) {
      logger.error(`enrich_company_contact error: ${(error as Error).message}`);
      return `**Error:** contact enrichment failed (${(error as Error).message}). Continue with web_search.`;
    }
  },
  {
    name: 'enrich_company_contact',
    description: `Look ONE named person at the company up in a people-data provider (treg.to): current title, employer, LinkedIn URL, location — and, with \`with_phone\`, a phone number with a live-line check.

Use it on your shortlist, after the web has given you a name. It does not discover people.

The result is a vendor record, not proof: confirm the employer matches the company before saving anything from it.

Returns:
    Markdown — the profile found (or a miss), any phone number found, and the source strings to cite.`,
    schema: enrichCompanyContactSchema,
  },
);
