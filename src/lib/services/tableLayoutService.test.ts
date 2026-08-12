import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InvalidTableIdError,
  InvalidTableLayoutError,
  TableLayoutService,
  parseColumnLayoutState,
} from './tableLayoutService';

const repoMocks = {
  findAll: vi.fn(),
  findByTableId: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};

class MockRepo {
  findAll = repoMocks.findAll;
  findByTableId = repoMocks.findByTableId;
  upsert = repoMocks.upsert;
  delete = repoMocks.delete;
}

const LAYOUT = {
  order: ['a', 'b', 'c'],
  hidden: ['c'],
  groups: [{ id: 'group-1', columnIds: ['a', 'b'], collapsed: false }],
};

function service() {
  return new TableLayoutService(new MockRepo() as never);
}

beforeEach(() => {
  Object.values(repoMocks).forEach((m) => m.mockReset());
});

describe('parseColumnLayoutState', () => {
  it('accepts a well-formed layout', () => {
    expect(parseColumnLayoutState(LAYOUT)).toEqual(LAYOUT);
  });

  it('drops unknown keys rather than storing them', () => {
    expect(parseColumnLayoutState({ ...LAYOUT, widths: { a: 100 } })).toEqual(LAYOUT);
  });

  it('rejects non-objects, arrays, and null', () => {
    expect(parseColumnLayoutState(null)).toBeNull();
    expect(parseColumnLayoutState('nope')).toBeNull();
    expect(parseColumnLayoutState([LAYOUT])).toBeNull();
  });

  it('rejects a layout whose order or hidden is not a string array', () => {
    expect(parseColumnLayoutState({ ...LAYOUT, order: [1, 2] })).toBeNull();
    expect(parseColumnLayoutState({ ...LAYOUT, hidden: 'c' })).toBeNull();
  });

  it('rejects a malformed group entry', () => {
    expect(
      parseColumnLayoutState({ ...LAYOUT, groups: [{ id: 'g', columnIds: ['a'] }] }),
    ).toBeNull();
    expect(parseColumnLayoutState({ ...LAYOUT, groups: [{ id: 1 }] })).toBeNull();
    expect(parseColumnLayoutState({ ...LAYOUT, groups: 'none' })).toBeNull();
  });
});

describe('TableLayoutService.listLayouts', () => {
  it('keys every stored layout by its table id', async () => {
    repoMocks.findAll.mockResolvedValue([
      { tableId: 'master-data', layout: LAYOUT, updatedAt: null, updatedBy: null },
      { tableId: 'smart-files', layout: LAYOUT, updatedAt: null, updatedBy: null },
    ]);

    expect(await service().listLayouts()).toEqual({
      'master-data': LAYOUT,
      'smart-files': LAYOUT,
    });
  });

  it('skips rows with an unreadable layout instead of failing the whole request', async () => {
    repoMocks.findAll.mockResolvedValue([
      { tableId: 'master-data', layout: LAYOUT, updatedAt: null, updatedBy: null },
      { tableId: 'legacy', layout: { columns: ['a'] }, updatedAt: null, updatedBy: null },
    ]);

    expect(await service().listLayouts()).toEqual({ 'master-data': LAYOUT });
  });

  it('returns {} when nothing is stored', async () => {
    repoMocks.findAll.mockResolvedValue([]);
    expect(await service().listLayouts()).toEqual({});
  });
});

describe('TableLayoutService.getLayout', () => {
  it('returns the parsed layout with its audit timestamp', async () => {
    repoMocks.findByTableId.mockResolvedValue({
      tableId: 'master-data',
      layout: LAYOUT,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedBy: 'u1',
    });

    expect(await service().getLayout('master-data')).toEqual({
      tableId: 'master-data',
      layout: LAYOUT,
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns null when the table has no stored layout', async () => {
    repoMocks.findByTableId.mockResolvedValue(null);
    expect(await service().getLayout('master-data')).toBeNull();
  });

  it('returns null when the stored blob is unreadable', async () => {
    repoMocks.findByTableId.mockResolvedValue({
      tableId: 'legacy',
      layout: { columns: [] },
      updatedAt: null,
      updatedBy: null,
    });
    expect(await service().getLayout('legacy')).toBeNull();
  });

  it('rejects a blank table id', async () => {
    await expect(service().getLayout('   ')).rejects.toBeInstanceOf(InvalidTableIdError);
    expect(repoMocks.findByTableId).not.toHaveBeenCalled();
  });
});

describe('TableLayoutService.saveLayout', () => {
  it('persists the sanitised layout under a trimmed table id', async () => {
    repoMocks.upsert.mockResolvedValue('2026-08-11T00:00:00.000Z');

    const result = await service().saveLayout(
      '  master-data  ',
      { ...LAYOUT, widths: { a: 100 } },
      'u1',
    );

    expect(repoMocks.upsert).toHaveBeenCalledWith('master-data', LAYOUT, 'u1');
    expect(result).toEqual({
      tableId: 'master-data',
      layout: LAYOUT,
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
  });

  it('rejects a table id that is not a plausible identifier', async () => {
    await expect(
      service().saveLayout('drop table; --', LAYOUT),
    ).rejects.toBeInstanceOf(InvalidTableIdError);
    await expect(
      service().saveLayout('x'.repeat(65), LAYOUT),
    ).rejects.toBeInstanceOf(InvalidTableIdError);
    expect(repoMocks.upsert).not.toHaveBeenCalled();
  });

  it('accepts the templated pipeline table ids', async () => {
    repoMocks.upsert.mockResolvedValue(null);
    await service().saveLayout('pipeline-inbound:active', LAYOUT);
    expect(repoMocks.upsert).toHaveBeenCalledWith('pipeline-inbound:active', LAYOUT, null);
  });

  it('rejects a layout that is not a ColumnLayoutState', async () => {
    await expect(
      service().saveLayout('master-data', { columns: ['a'] }),
    ).rejects.toBeInstanceOf(InvalidTableLayoutError);
    expect(repoMocks.upsert).not.toHaveBeenCalled();
  });

  it('rejects a missing table id', async () => {
    await expect(
      service().saveLayout('', LAYOUT),
    ).rejects.toBeInstanceOf(InvalidTableIdError);
    expect(repoMocks.upsert).not.toHaveBeenCalled();
  });

  it('records a null author when no user is supplied', async () => {
    repoMocks.upsert.mockResolvedValue(null);
    await service().saveLayout('master-data', LAYOUT);
    expect(repoMocks.upsert).toHaveBeenCalledWith('master-data', LAYOUT, null);
  });
});

describe('TableLayoutService.resetLayout', () => {
  it('deletes the stored layout for the table', async () => {
    repoMocks.delete.mockResolvedValue(undefined);
    await service().resetLayout('master-data');
    expect(repoMocks.delete).toHaveBeenCalledWith('master-data');
  });

  it('rejects a blank table id', async () => {
    await expect(service().resetLayout(' ')).rejects.toBeInstanceOf(InvalidTableIdError);
    expect(repoMocks.delete).not.toHaveBeenCalled();
  });
});
