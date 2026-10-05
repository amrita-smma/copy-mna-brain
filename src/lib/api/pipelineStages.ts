import { apiRequest } from '@/lib/api/client';
import type { PipelineStageDef } from '@/lib/pipeline/stages';

/** The workspace's pipeline stages in order, deleted ones included (flagged). */
export function listPipelineStages(): Promise<PipelineStageDef[]> {
  return apiRequest<PipelineStageDef[]>('/api/pipeline-stages');
}

export function createPipelineStage(input: {
  code: string;
  name: string;
  description: string;
  afterKey: string;
}): Promise<PipelineStageDef> {
  return apiRequest<PipelineStageDef>('/api/pipeline-stages', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Save several stages' code, name and description in one request; returns the stage list. */
export function updatePipelineStages(
  stages: ReadonlyArray<{ key: string; code: string; name: string; description: string }>,
): Promise<PipelineStageDef[]> {
  return apiRequest<PipelineStageDef[]>('/api/pipeline-stages', {
    method: 'PATCH',
    body: JSON.stringify({ stages }),
  });
}

/** Move a stage one position; returns the reordered stage list. */
export function movePipelineStage(
  key: string,
  direction: 'up' | 'down',
): Promise<PipelineStageDef[]> {
  return apiRequest<PipelineStageDef[]>(
    `/api/pipeline-stages/${encodeURIComponent(key)}/move`,
    { method: 'POST', body: JSON.stringify({ direction }) },
  );
}

/** Delete a stage, moving its active companies to `moveTo` first. */
export function deletePipelineStage(key: string, moveTo?: string): Promise<{ moved: number }> {
  const search = moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : '';
  return apiRequest<{ moved: number }>(
    `/api/pipeline-stages/${encodeURIComponent(key)}${search}`,
    { method: 'DELETE' },
  );
}
