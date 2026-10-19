import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { CorrespondentRepository } from '@/lib/repositories';
import { logger } from '../../logger';
import {
  CRM_CONTACT_WRITABLE_FIELDS,
  missingProfileFields,
  type CrmContactWritableField,
} from '../constants';

/** Longest bio the agent may write; past this it is an essay, not a CRM field. */
const MAX_BIO_CHARS = 600;

const FIELD_SCHEMA = {
  title: z.string().trim().min(1).max(200).optional()
    .describe('Job title exactly as the firm publishes it, e.g. "Managing Director, TMT".'),
  phone: z.string().trim().min(1).max(60).optional()
    .describe("Direct line, only if published FOR THIS PERSON. Never a switchboard or a colleague's number."),
  type: z.string().trim().min(1).max(60).optional()
    .describe('What kind of contact they are, e.g. "Banker", "Lawyer", "Founder".'),
  department: z.string().trim().min(1).max(120).optional()
    .describe('The desk they sit on, e.g. "M&A", "Debt Capital Markets", "Financial Sponsors".'),
  specialization: z.string().trim().min(1).max(200).optional()
    .describe('Sector or product focus, e.g. "semiconductors", "healthcare services".'),
  seniority: z.string().trim().min(1).max(60).optional()
    .describe('Seniority band, e.g. "Managing Director", "Vice President", "Analyst".'),
  coverage_region: z.string().trim().min(1).max(120).optional()
    .describe('The geography of their mandate — the markets they cover, e.g. "Southeast Asia", "North America" — as stated in a bio, team page or deal release. NOT where they are based: never fill this from an office city or a profile location.'),
  linkedin_url: z.string().trim().url().max(300).optional()
    .describe('Full https:// URL of their LinkedIn profile.'),
  bio: z.string().trim().min(1).max(MAX_BIO_CHARS).optional()
    .describe('Two or three sentences: career line, notable mandates, education. No marketing copy.'),
} as const;

/** Lower-cased name words of two letters or more — initials and punctuation drop out. */
function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z]+/)
      .filter((t) => t.length >= 2),
  );
}

/**
 * Is `proposed` a correction of `current` rather than a different person?
 *
 * The ingest often only has what the mail header gave it — "Jane", "J. Doe",
 * "jdoe" or the bare address — and a full name is a legitimate fill. What must
 * never pass is a rename to someone else, because then the wrong match stops
 * being visible. So: the new name has to share a word with the old one, unless
 * the old one is just the email (or its local part) and carries no name at all.
 */
export function isNameCorrection(
  current: string,
  proposed: string,
  email: string | null | undefined,
): boolean {
  const cur = current.trim().toLowerCase();
  const localPart = email?.split('@')[0]?.trim().toLowerCase();
  if (!cur || cur.includes('@') || (localPart && cur === localPart)) return true;
  const next = nameTokens(proposed);
  return [...nameTokens(current)].some((t) => next.has(t));
}

export const updateCrmContactSchema = z.object({
  correspondent_id: z.string().describe('The contact id you were given.'),
  name: z.string().trim().min(2).max(200).optional()
    .describe(
      'The person\'s full name, only to complete or correct the one on file for the SAME person (e.g. "Jane" → "Jane Doe", "J. Doe" → "Jane Doe"). Must share a word with the current name. Never a different person.',
    ),
  ...FIELD_SCHEMA,
  sources: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(12)
    .describe(
      'The URLs the values above came from, including the one that proved this is the right person at the right firm. Required — a value with no source does not get written.',
    ),
  overwrite: z
    .array(z.enum(CRM_CONTACT_WRITABLE_FIELDS))
    .max(CRM_CONTACT_WRITABLE_FIELDS.length)
    .optional()
    .describe(
      'Fields that already hold a value and that you are deliberately replacing because the stored one is demonstrably out of date. Everything not listed here is only written when the field is empty.',
    ),
});

export type UpdateCrmContactInput = z.infer<typeof updateCrmContactSchema>;

/**
 * Write the agent's findings onto the contact.
 *
 * Everything lands in `correspondent_curation` — the human/agent overlay —
 * never on the ingest-owned `correspondents` row. `CRMService.updateContact`
 * does that routing, and the `correspondent_effective` view COALESCEs the
 * overlay back over the base on read, so the next MBOX re-ingest cannot
 * clobber what was found here. (The one editable field that lives on the base
 * table is `email`, and this tool deliberately cannot write it — see
 * `../constants`.)
 *
 * Two guards the model cannot talk its way past, because both are enforced
 * here rather than in the prompt:
 *
 *  - **Fill, don't flatten.** A field with an effective value is skipped
 *    unless the model named it in `overwrite`. A colleague's hand-entered
 *    title outranks a search result.
 *  - **No source, no write.** `sources` is required by the schema, so a value
 *    the agent cannot attribute never reaches the database.
 *
 * The edit is stamped with the user who pressed the button
 * (`triggered_by_user_id`, set on the run's tool config by the workforce
 * runtime), not left anonymous: `correspondent_curation.edited_by` is what the
 * CRM shows when someone asks who changed a field, and "nobody" is a worse
 * answer than "the person who asked for this".
 */
export const updateCrmContact = tool(
  async (input: UpdateCrmContactInput, runtime?: RunnableConfig) => {
    const { correspondent_id, sources, overwrite, name, ...fields } = input;
    logger.debug(
      `🔧 TOOL CALLED: update_crm_contact(${correspondent_id}, ${Object.keys(fields).join(', ') || 'no fields'})`,
    );

    const proposed = CRM_CONTACT_WRITABLE_FIELDS.filter(
      (f) => typeof fields[f] === 'string',
    );
    if (proposed.length === 0 && !name) {
      return '**Nothing to write.** You called update_crm_contact without a single profile field. If you found nothing you can evidence, skip the write and say so in your report.';
    }

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const contact = await new CorrespondentRepository(db).findById(
        correspondent_id,
        workspaceId,
      );
      if (!contact) {
        return `**Error:** No CRM contact with id ${correspondent_id} is visible in this workspace. Nothing was written.`;
      }

      const empty = new Set(missingProfileFields(contact));
      const forced = new Set(overwrite ?? []);

      const patch: Partial<Record<CrmContactWritableField | 'name', string>> = {};
      const written: string[] = [];
      const overwritten: string[] = [];
      const skipped: string[] = [];

      if (name && name !== contact.name.trim()) {
        if (isNameCorrection(contact.name, name, contact.email)) {
          patch.name = name;
          overwritten.push(`name: "${contact.name}" → "${name}"`);
        } else {
          skipped.push(
            `name — "${name}" shares no word with "${contact.name}", so it reads as a different person. Not written; report the conflict instead`,
          );
        }
      }

      for (const field of proposed) {
        const value = fields[field] as string;
        if (empty.has(field)) {
          patch[field] = value;
          written.push(`${field} = "${value}"`);
        } else if (forced.has(field)) {
          patch[field] = value;
          overwritten.push(`${field}: "${contact[field]}" → "${value}"`);
        } else {
          skipped.push(
            `${field} — already "${contact[field]}"; list it in \`overwrite\` if yours is newer`,
          );
        }
      }

      if (Object.keys(patch).length === 0) {
        return `**Nothing written.** None of the fields you proposed could be written:
${skipped.map((s) => `- ${s}`).join('\n')}

Report what you found and why you did not overwrite it.`;
      }

      const editedBy =
        (runtime?.configurable?.triggered_by_user_id as string | undefined) ?? null;
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import('@/lib/services/container');
      const { crmService } = createContainer(db, workspaceId);
      await crmService.updateContact(correspondent_id, {
        ...patch,
        // Only stamp when the run has an owner — passing null would clear
        // whoever edited the row last.
        ...(editedBy ? { last_edited_by_user_id: editedBy } : {}),
      });

      logger.debug(
        `✓ update_crm_contact: ${written.length} filled, ${overwritten.length} overwritten on ${contact.name}`,
      );

      const sections = [
        `✓ Updated ${contact.name} — ${Object.keys(patch).length} field(s) written to the CRM overlay.`,
      ];
      if (written.length > 0) {
        sections.push(`**Filled:**\n${written.map((w) => `- ${w}`).join('\n')}`);
      }
      if (overwritten.length > 0) {
        sections.push(
          `**Overwrote:**\n${overwritten.map((o) => `- ${o}`).join('\n')}`,
        );
      }
      if (skipped.length > 0) {
        sections.push(`**Skipped:**\n${skipped.map((s) => `- ${s}`).join('\n')}`);
      }
      sections.push(
        `**Sources you passed:** ${sources.length}. Name them in the final report — they are not stored on the row.`,
      );
      return sections.join('\n\n');
    } catch (error) {
      logger.error(`update_crm_contact error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message} — nothing was written.`;
    }
  },
  {
    name: 'update_crm_contact',
    description: `Record what you found about a CRM contact. Call this ONCE, with every field you can evidence.

Writes to the CRM's override layer, so a later mailbox re-ingest cannot overwrite it. You can set: name, title, phone, type, department, specialization, seniority, coverage_region, linkedin_url, bio.

\`name\` completes or corrects the full name of the SAME person ("Jane" → "Jane Doe"); it is refused when it shares no word with the name on file. You CANNOT set their email. If what you found points to a different person than the name or email on file, write nothing and report it.

Only empty fields are filled. A field that already holds a value is skipped and reported back to you, unless you name it in \`overwrite\` — do that only when your source is the firm's own current page and the stored value is demonstrably stale.

\`sources\` is required: list the URLs the values came from, including the one proving this is the right person at the right firm. A value you cannot attribute should not be passed at all.

Returns:
    Markdown — what was written, what was skipped and why.`,
    schema: updateCrmContactSchema,
  },
);
