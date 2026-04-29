import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { FileRepository } from "@/lib/repositories";

export function formatNotesResults(notes: any[]): string {
  let result = `**Files Results (${notes.length} records):**\n\n`;

  const noteRefs: {
    id: string;
    file_name: string;
    file_link: string;
    file_date: string | null;
    tags: string[];
    structured_notes: string | null;
    matched_companies: any[];
  }[] = [];

  notes.forEach((note, index) => {
    let structured = null;
    try {
      if (note.structured_notes) {
        structured = typeof note.structured_notes === 'string'
          ? JSON.parse(note.structured_notes)
          : note.structured_notes;
      }
    } catch (e) { }

    result += `### ${index + 1}. ${note.file_name}\n`;
    result += `- **Date:** ${note.file_date || 'N/A'}\n`;
    result += `- **Tags:** ${note.tags?.join(', ') || 'None'}\n`;

    if (structured && structured.summary) {
      result += `- **Summary:** ${structured.summary}\n`;
    } else if (note.raw_notes) {
      const excerpt = note.raw_notes.length > 200
        ? note.raw_notes.substring(0, 200) + "..."
        : note.raw_notes;
      result += `- **Excerpt:** ${excerpt}\n`;
    }

    if (structured && structured.key_points && structured.key_points.length > 0) {
      result += `- **Key Points:**\n  - ${structured.key_points.slice(0, 3).join('\n  - ')}\n`;
    }

    result += `\n`;

    noteRefs.push({
      id: note.id,
      file_name: note.file_name,
      file_link: note.file_link,
      file_date: note.file_date || null,
      tags: note.tags || [],
      structured_notes: typeof note.structured_notes === 'string'
        ? note.structured_notes
        : note.structured_notes ? JSON.stringify(note.structured_notes) : null,
      matched_companies: note.matched_companies || [],
    });
  });

  if (noteRefs.length > 0) {
    result += `\n<!-- FILES_JSON:${JSON.stringify(noteRefs)} -->`;
  }

  return result;
}

/**
 * Query files based on matched companies, tags, or search terms.
 */
export const queryMeetingNotes = tool(
  async ({
    company_name,
    tag,
    search_term,
    limit = 10,
  }: {
    company_name?: string;
    tag?: string;
    search_term?: string;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: query_files(company='${company_name}', tag='${tag}', search='${search_term}')`
    );

    try {
      const fileRepo = new FileRepository(createDb());
      const notes = await fileRepo.searchForAgent({
        companyName: company_name,
        tag,
        searchTerm: search_term,
        limit,
      });

      if (!notes || notes.length === 0) {
        return "No files found matching your criteria.";
      }

      return formatNotesResults(notes);
    } catch (error) {
      logger.error(`Query error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_files",
    description: `Search and retrieve files.

Use this tool to find meeting records, summaries, and key points related to specific companies, tags, or topics.
You can filter by company name, tag, or use a general search term.

Args:
    company_name: Filter by associated company name
    tag: Filter by specific tag (e.g., "M&A", "Strategy", "Financials")
    search_term: General search term for file name or note content
    limit: Maximum number of results (default: 10, max: 20)

Returns:
    A summary of matching files.`,
    schema: z.object({
      company_name: z.string().optional().describe("Filter by company name"),
      tag: z.string().optional().describe("Filter by tag"),
      search_term: z.string().optional().describe("General search term"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    }),
  }
);
