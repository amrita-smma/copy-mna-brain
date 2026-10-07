import { apiRequest } from '@/lib/api/client';
import type { PipelineHeading, PipelineHeadingInput } from '@/lib/pipeline/heading';

/** The active workspace's pipeline heading, already resolved to defaults. */
export function getPipelineHeading(): Promise<PipelineHeading> {
  return apiRequest<PipelineHeading>('/api/pipeline-heading');
}

/**
 * Rename the pipeline heading for the whole workspace. Pass `null` (or a blank
 * string) on a field to clear it back to the product default; the resolved
 * heading comes back so the caller can paint it without a refetch.
 */
export function savePipelineHeading(input: PipelineHeadingInput): Promise<PipelineHeading> {
  return apiRequest<PipelineHeading>('/api/pipeline-heading', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}
