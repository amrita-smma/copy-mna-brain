import type { DbClient } from "@/lib/repositories/types";
import { PipelineStageRepository } from "@/lib/repositories/pipelineStageRepository";
import { isInPipelineStage, stageLabel, type PipelineStageDef } from "@/lib/pipeline/stages";
import { logger } from "../../logger";

/**
 * A function naming a companies.pipeline_stage value the way users see it in
 * this workspace — "L3 · Due Diligence", "L6 · Post-Close Review" — so tool
 * replies never show a raw `stg-…` key. Pre-pipeline buckets and unknown
 * values pass through. One stage-list read per tool call; when that read
 * fails, every stage passes through as its key rather than failing the tool.
 */
export async function loadStageLabeler(
  db: DbClient,
  workspaceId: string,
): Promise<(stage: string | null | undefined) => string | null> {
  let stages: PipelineStageDef[] = [];
  try {
    const rows = await new PipelineStageRepository(db, workspaceId).list();
    stages = rows.map((r) => ({
      key: r.key,
      code: r.code,
      name: r.name,
      description: r.description,
      position: r.position,
      deleted: r.deleted_at !== null,
    }));
  } catch (error) {
    logger.debug(`stage labels unavailable: ${(error as Error).message}`);
  }
  return (stage) => {
    if (!stage) return null;
    return isInPipelineStage(stage) ? stageLabel(stages, stage) : stage;
  };
}
