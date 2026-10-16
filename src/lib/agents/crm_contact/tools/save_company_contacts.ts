import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { CompanyNotFoundError } from '@/lib/services/companyContactDiscoveryService';
import { logger } from '../../logger';
import { MAX_COMPANY_CONTACTS } from '../constants';

/** Generic inboxes are not a person's email — refuse them at the tool, not just in the prompt. */
const ROLE_MAILBOX = /^(info|sales|contact|hello|admin|support|marketing|enquiries|inquiries|office|hr|careers|partnerships?|bd)@/i;

const contactSchema = z.object({
  name: z.string().trim().min(2).max(200).describe('Full name, as the company or their profile gives it.'),
  title: z.string().trim().min(1).max(200).optional()
    .describe('Current job title exactly as published, e.g. "VP Business Development".'),
  email: z.string().trim().email().max(200).optional()
    .describe('Only an address PUBLISHED for this person. Never a guessed pattern, never a generic inbox.'),
  phone: z.string().trim().min(1).max(60).optional()
    .describe('Only a number published for this person, or a non-dead enrich_company_contact hit for them.'),
  linkedin_url: z.string().trim().url().max(300).optional()
    .describe('Full https:// URL of their LinkedIn profile.'),
  department: z.string().trim().min(1).max(120).optional()
    .describe('Their function, e.g. "Business Development", "Executive", "Partnerships".'),
  seniority: z.string().trim().min(1).max(60).optional()
    .describe('Seniority band, e.g. "C-level", "VP", "Manager".'),
  sources: z.array(z.string().trim().min(1).max(500)).min(1).max(8)
    .describe('URLs tying this person to this company today. Required.'),
});

export const saveCompanyContactsSchema = z.object({
  company_id: z.string().describe('The company id named in your instruction.'),
  contacts: z
    .array(contactSchema)
    .min(1)
    .max(MAX_COMPANY_CONTACTS)
    .describe(`Up to ${MAX_COMPANY_CONTACTS} people, best partnership contact first.`),
});

export type SaveCompanyContactsInput = z.infer<typeof saveCompanyContactsSchema>;

/**
 * File the agent's people into the CRM as correspondents of the company's
 * CRM firm — linking or creating that firm first
 * (`CompanyContactDiscoveryService.saveContacts`).
 *
 * Guards enforced here or below rather than trusted to the prompt: every
 * person needs sources (schema), at most {@link MAX_COMPANY_CONTACTS} per
 * call (schema), a generic inbox is stripped from `email`, and someone the
 * CRM already holds — by email or by name at the firm — is merged into
 * (empty fields only) instead of duplicated. Nothing is ever deleted.
 *
 * Stamped with the user who pressed the button (`triggered_by_user_id`).
 */
export const saveCompanyContacts = tool(
  async ({ company_id, contacts }: SaveCompanyContactsInput, runtime?: RunnableConfig) => {
    logger.debug(`🔧 TOOL CALLED: save_company_contacts(${company_id}, ${contacts.length})`);

    const notes: string[] = [];
    const rows = contacts.map((c) => {
      let email = c.email;
      if (email && ROLE_MAILBOX.test(email)) {
        notes.push(`${c.name} — dropped "${email}", a generic inbox is not their email`);
        email = undefined;
      }
      return {
        name: c.name,
        title: c.title,
        email,
        phone: c.phone,
        linkedinUrl: c.linkedin_url,
        department: c.department,
        seniority: c.seniority,
      };
    });

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const editedBy =
        (runtime?.configurable?.triggered_by_user_id as string | undefined) ?? null;
      const { companyContactDiscoveryService } = createContainer(db, workspaceId);
      const { employer, createdIds, mergedIds, mergedElsewhere } =
        await companyContactDiscoveryService.saveContacts(
        company_id,
        rows,
        { editedBy },
      );

      logger.debug(
        `✓ save_company_contacts: ${createdIds.length} added, ${mergedIds.length} merged under ${employer.name}`,
      );

      const sections = [
        `✓ Filed under CRM firm **${employer.name}**: ${createdIds.length} new contact(s), ${mergedIds.length} merged into existing record(s).`,
      ];
      if (mergedElsewhere.length > 0) {
        sections.push(
          `**Already in the CRM under another firm** (matched by email, left there — the CRM keys people on email):\n${mergedElsewhere
            .map((m) => `- ${m.name}`)
            .join('\n')}\nSay so in your report: they will not show on this company's card until a human moves them.`,
        );
      }
      if (notes.length > 0) sections.push(`**Adjusted:**\n${notes.map((n) => `- ${n}`).join('\n')}`);
      sections.push(
        `**Sources you passed:** ${contacts.reduce((n, c) => n + c.sources.length, 0)}. Name them in the final report — they are not stored on the CRM record.`,
      );
      return sections.join('\n\n');
    } catch (error) {
      if (error instanceof CompanyNotFoundError) {
        return `**Error:** No company with id ${company_id} is visible in this workspace. Nothing was saved.`;
      }
      logger.error(`save_company_contacts error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message} — nothing was saved.`;
    }
  },
  {
    name: 'save_company_contacts',
    description: `File the company's partnership contacts into the CRM, under the company's CRM firm (created if the CRM has never seen the company). Call this ONCE, at the end, with up to ${MAX_COMPANY_CONTACTS} people, best partnership contact first.

Someone the CRM already holds — same email, or same name at this firm — is merged into: only their empty fields are filled, and their name and email are never changed. Nothing is deleted. If you found nobody you can evidence, do not call it.

Each person needs \`sources\`: the URLs tying them to this company today. Email and phone only when published for that person (or, for phone, a non-dead enrich_company_contact hit) — never guessed.

Returns:
    Markdown — the CRM firm, how many were added and merged, and anything adjusted.`,
    schema: saveCompanyContactsSchema,
  },
);
