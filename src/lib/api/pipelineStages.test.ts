import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import {
  createPipelineStage,
  deletePipelineStage,
  listPipelineStages,
  movePipelineStage,
  updatePipelineStages,
} from './pipelineStages';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({});
});

describe('pipeline stage client', () => {
  it('lists the stages', async () => {
    await listPipelineStages();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-stages');
  });

  it('creates a stage with its position', async () => {
    await createPipelineStage({ code: 'L6', name: 'Post-Close', description: '', afterKey: 'L5' });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-stages', {
      method: 'POST',
      body: JSON.stringify({ code: 'L6', name: 'Post-Close', description: '', afterKey: 'L5' }),
    });
  });

  it('saves several stages in one PATCH', async () => {
    const stages = [
      { key: 'L1', code: 'L2', name: 'Deep Dive', description: '' },
      { key: 'L2', code: 'L1', name: 'Screening', description: 'First pass' },
    ];
    await updatePipelineStages(stages);
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-stages', {
      method: 'PATCH',
      body: JSON.stringify({ stages }),
    });
  });

  it('moves a stage one position', async () => {
    await movePipelineStage('L2', 'up');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-stages/L2/move', {
      method: 'POST',
      body: JSON.stringify({ direction: 'up' }),
    });
  });

  it('deletes a stage, naming where its companies go only when given', async () => {
    await deletePipelineStage('L2', 'L3');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-stages/L2?moveTo=L3', {
      method: 'DELETE',
    });
    await deletePipelineStage('L4');
    expect(apiRequestMock).toHaveBeenLastCalledWith('/api/pipeline-stages/L4', { method: 'DELETE' });
  });
});
