"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getPipelineRequiredFields } from "@/lib/api/pipelineRequiredFields";
import {
  DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS,
  pipelineRequiredFieldsFor,
  type PipelineFieldKey,
  type PipelineRequiredField,
} from "@/lib/pipeline/requiredFields";

/** react-query key root; invalidate it after saving Required Fields. */
export const PIPELINE_REQUIRED_FIELDS_QUERY_ROOT = "pipeline-required-fields";

export interface PipelineRequiredFieldsState {
  keys: PipelineFieldKey[];
  /** The enforced requirement definitions, in canonical order. */
  fields: PipelineRequiredField[];
  /** True for a field this workspace requires to enter the pipeline. */
  isRequired: (key: PipelineFieldKey) => boolean;
}

/**
 * The active workspace's Pipeline Settings → Required Fields, shared through
 * the react-query cache. Until it loads, every field reads as required (the
 * default) so a box never under-states the gate.
 */
export function usePipelineRequiredFields(): PipelineRequiredFieldsState {
  const slug = getWorkspaceSlugFromUrl();
  const { data } = useQuery({
    queryKey: [PIPELINE_REQUIRED_FIELDS_QUERY_ROOT, slug],
    queryFn: getPipelineRequiredFields,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const fields = pipelineRequiredFieldsFor(data ?? DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS);
    const keys = fields.map((f) => f.key);
    return { keys, fields, isRequired: (key: PipelineFieldKey) => keys.includes(key) };
  }, [data]);
}
