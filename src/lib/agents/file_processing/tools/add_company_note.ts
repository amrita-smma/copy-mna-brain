import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { DealNoteRepository, PastAcquisitionRepository } from "@/lib/repositories";

/**
 * Add a note to a matched company (deal_notes) or past acquisition
 * (appended into the notes column).
 */
export const addCompanyNoteTool = tool(
  async ({
    id,
    type,
    content,
    stage,
  }: {
    id: string;
    type: "company" | "past_acquisition";
    content: string;
    stage?: string;
  }) => {
    logger.debug(`🔧 TOOL CALLED: add_company_note(id='${id}', type='${type}')`);
    try {
      const db = createDb();

      if (type === "company") {
        const dealNoteRepo = new DealNoteRepository(db);
        await dealNoteRepo.insert({
          deal_id: id,
          content,
          stage: stage || "File",
        });
      } else {
        const pastRepo = new PastAcquisitionRepository(db);
        const existingNotes = (await pastRepo.findNotesById(id)) ?? "";
        const updatedNotes = existingNotes ? `${existingNotes}\n---\n${content}` : content;
        await pastRepo.updateNotes(id, updatedNotes);
      }

      return `Successfully added note to ${type} ${id}`;
    } catch (error) {
      return `Error adding note: ${(error as Error).message}`;
    }
  },
  {
    name: "add_company_note",
    description:
      "Adds a note to a matched company or past acquisition. If it's a company, it adds to deal_notes. If it's a past_acquisition, it appends to the notes column.",
    schema: z.object({
      id: z.string().describe("The UUID of the company or past acquisition"),
      type: z.enum(["company", "past_acquisition"]).describe("The type of the record"),
      content: z.string().describe("The content of the note to add"),
      stage: z.string().optional().describe("The deal stage if applicable (e.g., L0, L1)"),
    }),
  }
);
