import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { DealNoteRepository } from "@/lib/repositories";

/**
 * Add a note to a matched company (deal_notes).
 */
export const addCompanyNoteTool = tool(
  async ({
    id,
    content,
    stage,
  }: {
    id: string;
    content: string;
    stage?: string;
  }) => {
    logger.debug(`🔧 TOOL CALLED: add_company_note(id='${id}')`);
    try {
      const db = createDb();
      const dealNoteRepo = new DealNoteRepository(db);
      await dealNoteRepo.insert({
        deal_id: id,
        content,
        stage: stage || "File",
      });

      return `Successfully added note to company ${id}`;
    } catch (error) {
      return `Error adding note: ${(error as Error).message}`;
    }
  },
  {
    name: "add_company_note",
    description: "Adds a note to a matched company's deal_notes.",
    schema: z.object({
      id: z.string().describe("The UUID of the company"),
      content: z.string().describe("The content of the note to add"),
      stage: z.string().optional().describe("The deal stage if applicable (e.g., L0, L1)"),
    }),
  }
);
