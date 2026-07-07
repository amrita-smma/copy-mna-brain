import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { UserRepository } from '@/lib/repositories';

/**
 * lookup_user — resolve a platform user by a name or email fragment.
 *
 * Returns ONLY the matching users' name and email — never ids, roles, or any
 * other profile field. Its purpose is to let the agent turn a natural-language
 * reference ("send an email to nico ...") into the concrete email address that
 * `send_email` needs, without exposing anything else about the user record.
 */

const MAX_RESULTS = 10;

export const lookupUser = tool(
  async ({ query }: { query: string }) => {
    logger.debug(`🔧 TOOL CALLED: lookup_user(query='${query ?? ''}')`);

    const needle = query?.trim().toLowerCase();
    if (!needle) {
      return '**Error:** query is required (a name or email fragment).';
    }

    try {
      const userRepo = new UserRepository(createDb());
      const users = await userRepo.findAll();

      const matches = users
        .filter((u) => {
          const name = u.name?.toLowerCase() ?? '';
          const email = u.email?.toLowerCase() ?? '';
          return name.includes(needle) || email.includes(needle);
        })
        // Only expose name + email — deliberately drop id and role.
        .map((u) => ({ name: u.name ?? '', email: u.email ?? '' }))
        .filter((u) => u.email.length > 0);

      if (matches.length === 0) {
        return `No platform user found matching "${query.trim()}".`;
      }

      const shown = matches.slice(0, MAX_RESULTS);
      const header = 'Name | Email';
      const separator = '--- | ---';
      const rows = shown.map((u) => `${u.name || '(no name)'} | ${u.email}`);

      let result = `**Matching users (${matches.length}${
        matches.length > MAX_RESULTS ? `, showing first ${MAX_RESULTS}` : ''
      }):**\n\n`;
      result += `| ${header} |\n| ${separator} |\n`;
      result += rows.map((r) => `| ${r} |`).join('\n');
      return result;
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`lookup_user failed: ${message}`);
      return `**Error:** ${message}`;
    }
  },
  {
    name: 'lookup_user',
    description: `Look up registered platform users by a name or email fragment. Returns ONLY each match's name and email — no ids, roles, or other fields.

Use this to resolve a person referenced by name into their email address before calling send_email. For example, when the user says "send an email to nico with ...", call lookup_user(query: "nico") to get nico's email, then pass that address to send_email's \`to\`.

Args:
    query: Required. A name or email fragment (case-insensitive, partial match against both name and email).

Returns:
    A markdown table of matching users (name, email), or a message when nothing matches.`,
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Name or email fragment to search for (partial, case-insensitive).'),
    }),
  },
);
