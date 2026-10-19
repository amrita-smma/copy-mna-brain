import { apiRequest } from '@/lib/api/client';
import type { PipelineFieldKey } from '@/lib/pipeline/requiredFields';

/** The active workspace's Pipeline Settings → Required Fields (pipeline entry gate). */
export function getPipelineRequiredFields(): Promise<PipelineFieldKey[]> {
  return apiRequest<PipelineFieldKey[]>('/api/pipeline-required-fields');
}

/** Save the required set. The server always keeps the company name. */
export function savePipelineRequiredFields(requiredFields: PipelineFieldKey[]): Promise<PipelineFieldKey[]> {
  return apiRequest<PipelineFieldKey[]>('/api/pipeline-required-fields', {
    method: 'PUT',
    body: JSON.stringify({ requiredFields }),
  });
}
