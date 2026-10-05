"use client";

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { listPipelineStages } from "@/lib/api/pipelineStages";
import { STAGE_LABELS } from "@/lib/constants";
import {
  BUILTIN_PIPELINE_STAGE_KEYS,
  CAPTAIN_FROM_STAGE_KEY,
  findStage,
  liveStages,
  stageCode,
  stageKeysFrom,
  isInPipelineStage,
  stageLabel,
  type PipelineStageDef,
} from "@/lib/pipeline/stages";

/** Shown until the workspace's stages load: the original keys, labelled by code only. */
const FALLBACK_STAGES: PipelineStageDef[] = BUILTIN_PIPELINE_STAGE_KEYS.map((key, position) => ({
  key,
  code: key,
  name: "",
  description: "",
  position,
  deleted: false,
}));

const QUERY_ROOT = "pipeline-stages";

export interface PipelineStagesState {
  /** Live stages in pipeline order. */
  live: PipelineStageDef[];
  liveKeys: string[];
  /** Live keys from L3 onward — where the deal lead is the Deal Captain. */
  captainKeys: string[];
  loading: boolean;
  /** "L3 · Due Diligence" (code only while loading; the raw key for an unknown stage). */
  label: (key: string) => string;
  code: (key: string) => string;
  description: (key: string) => string;
  /**
   * Any companies.pipeline_stage value for display: a workspace stage as
   * "L3 · Due Diligence", a pre-pipeline bucket by its fixed name.
   */
  displayLabel: (key: string) => string;
  /** Refetch after a settings change. */
  refresh: () => Promise<void>;
}

/**
 * The active workspace's pipeline stages (MB-651), fetched once and shared by
 * every view through the react-query cache. Views read stage names, order and
 * the Deal Captain range from here instead of hard-coding L0–L5.
 */
export function usePipelineStages(): PipelineStagesState {
  const queryClient = useQueryClient();
  const slug = getWorkspaceSlugFromUrl();
  const { data, isLoading } = useQuery({
    queryKey: [QUERY_ROOT, slug],
    queryFn: listPipelineStages,
    staleTime: 60_000,
  });

  const stages = data ?? FALLBACK_STAGES;
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] }),
    [queryClient],
  );

  return useMemo(() => {
    const live = liveStages(stages);
    return {
      live,
      liveKeys: live.map((s) => s.key),
      captainKeys: stageKeysFrom(stages, CAPTAIN_FROM_STAGE_KEY),
      loading: isLoading,
      label: (key: string) => stageLabel(stages, key),
      code: (key: string) => stageCode(stages, key),
      description: (key: string) => findStage(stages, key)?.description ?? "",
      displayLabel: (key: string) =>
        isInPipelineStage(key)
          ? stageLabel(stages, key)
          : STAGE_LABELS[key] ?? key,
      refresh,
    };
  }, [stages, isLoading, refresh]);
}
