import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getPipelineRequiredFields, savePipelineRequiredFields } from './pipelineRequiredFields';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue([]);
});

describe('pipeline required fields client', () => {
  it('reads the active workspace configuration', async () => {
    await getPipelineRequiredFields();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-required-fields');
  });

  it('saves the required set in one PUT', async () => {
    await savePipelineRequiredFields(['name', 'geography']);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-required-fields', {
      method: 'PUT',
      body: JSON.stringify({ requiredFields: ['name', 'geography'] }),
    });
  });
});
