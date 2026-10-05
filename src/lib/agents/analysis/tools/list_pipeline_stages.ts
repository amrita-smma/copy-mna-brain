import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { PipelineStageRepository } from "@/lib/repositories";
import { logger } from "../../logger";

/**
 * The workspace's deal pipeline stages, in order: each stage's permanent key
 * (what `pipeline_stage` filters take) next to the code and name users see.
 * Workspaces rename, reorder, add and delete stages, so the agent reads this
 * instead of assuming L0–L5.
 */
export const listPipelineStages = tool(
  async ({ include_deleted = false }: { include_deleted?: boolean } = {}) => {
    logger.debug(`🔧 TOOL CALLED: list_pipeline_stages(include_deleted=${include_deleted})`);

    try {
      const workspaceId = await getActiveWorkspaceId();
      const stageRepo = new PipelineStageRepository(createDb(), workspaceId);
      const rows = await stageRepo.list();
      const live = rows.filter((r) => r.deleted_at === null);
      const deleted = rows.filter((r) => r.deleted_at !== null);

      if (live.length === 0) return "No pipeline stages are configured in this workspace.";

      let out = `**Pipeline stages, in order (${live.length}):**\n\n`;
      out += `| # | Code | Name | Key |\n| --- | --- | --- | --- |\n`;
      live.forEach((s, i) => {
        out += `| ${i + 1} | ${s.code} | ${s.name} | ${s.key} |\n`;
      });
      out += `\nUse the **Key** in stage / stage_in filters. Users refer to stages by their **Code**.`;

      if (include_deleted && deleted.length > 0) {
        out += `\n\n**Deleted stages** (dropped deals may still sit in them; nothing can move into them):\n\n`;
        out += `| Code | Name | Key |\n| --- | --- | --- |\n`;
        for (const s of deleted) out += `| ${s.code} | ${s.name} | ${s.key} |\n`;
      }
      return out;
    } catch (error) {
      logger.error(`list_pipeline_stages error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "list_pipeline_stages",
    description: `List this workspace's deal pipeline stages in pipeline order — each stage's code (e.g. "L3"), name (e.g. "Due Diligence") and key.

Workspaces rename, renumber, reorder, add and delete their stages, so never assume the stages are L0–L5 with fixed names. Call this before filtering by a stage the user names, and pass the stage's **key** (not its code) to stage / stage_in. Pass include_deleted: true to also see deleted stages, where dropped deals may still sit.`,
    schema: z.object({
      include_deleted: z
        .boolean()
        .optional()
        .describe("Also list deleted stages (default false)"),
    }),
  },
);
