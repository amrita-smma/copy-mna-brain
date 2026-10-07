import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getPipelineHeading, savePipelineHeading } from './pipelineHeading';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({});
});

describe('pipeline heading client', () => {
  it('reads the active workspace heading', async () => {
    await getPipelineHeading();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-heading');
  });

  it('saves the heading in one PUT', async () => {
    await savePipelineHeading({ title: 'Acquisitions', subtitle: 'Live targets only' });
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-heading', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Acquisitions', subtitle: 'Live targets only' }),
    });
  });

  it('sends null to clear a field back to the default', async () => {
    await savePipelineHeading({ title: null, subtitle: null });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/pipeline-heading', {
      method: 'PUT',
      body: JSON.stringify({ title: null, subtitle: null }),
    });
  });

  it('returns the resolved heading the server stored', async () => {
    const saved = { title: 'Acquisitions', subtitle: 'Track companies through all stages' };
    apiRequestMock.mockResolvedValueOnce(saved);

    await expect(savePipelineHeading({ title: 'Acquisitions', subtitle: null })).resolves.toEqual(
      saved,
    );
  });
});
