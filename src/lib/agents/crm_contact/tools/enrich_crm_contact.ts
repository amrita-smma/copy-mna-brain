import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { CorrespondentRepository, EmployerRepository } from '@/lib/repositories';
import { enrichPerson, getTregApiKey, type TregPerson } from '@/lib/treg';
import { logger } from '../../logger';

/**
 * Mailbox domains that say nothing about the employer. A work email's domain
 * is the best company-domain hint we hold (employers carry no website), but
 * `jane@gmail.com` must not become `domain: gmail.com`.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.id', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'qq.com',
  '163.com', 'naver.com',
]);

export function companyDomainFromEmail(email: string | null | undefined): string | undefined {
  const domain = email?.split('@')[1]?.trim().toLowerCase();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return undefined;
  return domain;
}

/** `linkedin.com/in/x` → `https://linkedin.com/in/x`, so update_crm_contact's url() check passes. */
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
    line('Headline', person.headline),
    line('Location', person.location ?? person.country),
    line('LinkedIn URL', absoluteUrl(person.linkedin_url)),
    line('Company', company.name),
    line('Company website', company.website_url ?? person.company_domain),
    line('Company LinkedIn', absoluteUrl(company.linkedin_url)),
    line('Company industry', company.industry),
  ]
    .filter(Boolean)
    .join('\n');
}

export const enrichCrmContactSchema = z.object({
  correspondent_id: z.string().describe('The CRM contact id named in your instruction.'),
  linkedin_url: z
    .string()
    .trim()
    .url()
    .max(300)
    .optional()
    .describe(
      "A LinkedIn profile URL you have already tied to this person. The strongest identifier — pass it when you have one. Defaults to the one on file.",
    ),
  company_domain: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      "The firm's website domain, e.g. \"evercore.com\". Defaults to the domain of the contact's work email.",
    ),
});

export type EnrichCrmContactInput = z.infer<typeof enrichCrmContactSchema>;

export const enrichCrmContact = tool(
  async ({ correspondent_id, linkedin_url, company_domain }: EnrichCrmContactInput) => {
    logger.debug(`🔧 TOOL CALLED: enrich_crm_contact(${correspondent_id})`);

    if (!getTregApiKey()) {
      logger.warn('TREG_API_KEY not set');
      return 'Contact enrichment is not available (TREG_API_KEY is not set). Continue with web_search.';
    }

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
      const employer = await new EmployerRepository(db).findById(contact.employer_id);
      const firmName = employer?.name ?? 'an unknown firm';

      const query = {
        email: contact.email || undefined,
        full_name: contact.name,
        linkedin_url: linkedin_url ?? contact.linkedin_url ?? undefined,
        domain: company_domain ?? companyDomainFromEmail(contact.email),
      };
      const result = await enrichPerson(query);
      const sentWith = Object.entries(query)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ');

      if (!result.person) {
        logger.debug(`✓ enrich_crm_contact: miss for ${contact.name}`);
        return `No enrichment record found for ${contact.name} @ ${firmName} (matched on: ${sentWith}). Continue with web_search — a miss here says nothing about whether they have a public footprint.`;
      }

      const source = `treg.to people.enrich via ${result.servedBy ?? 'unknown provider'}${result.callId ? ` (call ${result.callId})` : ''}`;
      logger.debug(
        `✓ enrich_crm_contact: hit for ${contact.name} via ${result.servedBy} ($${(result.costMicro / 1e6).toFixed(4)})`,
      );

      return `## Enrichment record — ${result.person.full_name}

Matched on: ${sentWith}. Served by: ${result.servedBy ?? 'unknown'}.

${renderPerson(result.person)}

### Before you use this
- This is a **data-vendor record**, not the firm's own page. Check it is the same person: the name must match "${contact.name}" and the company must be ${firmName}. A different employer means the record is stale or a namesake — do not write from it.
- Treat it like an aggregator: good for a title, seniority, LinkedIn URL and a lead to follow; corroborate anything that matters on the firm's site or the LinkedIn profile before writing it.
- When you write a value taken from this record, list this as a source in update_crm_contact: \`${source}\`${result.person.linkedin_url ? `, alongside ${absoluteUrl(result.person.linkedin_url)}` : ''}.`;
    } catch (error) {
      logger.error(`enrich_crm_contact error: ${(error as Error).message}`);
      return `**Error:** contact enrichment failed (${(error as Error).message}). Continue with web_search.`;
    }
  },
  {
    name: 'enrich_crm_contact',
    description: `Look the CRM contact up in a people-data provider (treg.to) and get back a structured profile: job title, seniority, employer, LinkedIn URL, location.

Call this once right after get_crm_contact, before web_search — it is one cheap call that often answers title, seniority and LinkedIn URL outright, and gives your web searches a LinkedIn URL to anchor on.

The result is a vendor record, not proof: confirm the employer matches the firm on file before writing anything from it.

Args:
    correspondent_id: The contact's id.
    linkedin_url: Optional — a LinkedIn URL you already tied to this person.
    company_domain: Optional — the firm's domain, when the work email does not give it.

Returns:
    Markdown — the profile found (or a miss), and the source string to cite.`,
    schema: enrichCrmContactSchema,
  },
);
