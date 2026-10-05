import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompanyRepository,
  PipelineStageRepository,
  PipelineStageRow,
} from '@/lib/repositories';
import type { CompanyService } from './companyService';
import {
  PipelineStageLockedError,
  PipelineStageNotFoundError,
  PipelineStageService,
  PipelineStageValidationError,
} from './pipelineStageService';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  insertAfter: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  setPositions: vi.fn(),
  softDelete: vi.fn(),
  findActiveIdsByStage: vi.fn(),
  promoteMany: vi.fn(),
}));

function row(key: string, position: number, extra: Partial<PipelineStageRow> = {}): PipelineStageRow {
  return {
    id: `id-${key}`,
    workspace_id: 'ws-a',
    key,
    code: key,
    name: `${key} name`,
    description: '',
    position,
    created_at: '2026-10-04T00:00:00Z',
    updated_at: '2026-10-04T00:00:00Z',
    deleted_at: null,
    ...extra,
  };
}

const DEFAULT_ROWS = [
  row('L0', 0),
  row('L1', 1),
  row('L2', 2),
  row('L3', 3, { deleted_at: '2026-10-01T00:00:00Z' }),
  row('L4', 4),
];

function buildService() {
  const stageRepo = {
    list: mocks.list,
    insertAfter: mocks.insertAfter,
    update: mocks.update,
    updateMany: mocks.updateMany,
    setPositions: mocks.setPositions,
    softDelete: mocks.softDelete,
  } as unknown as PipelineStageRepository;
  const companyRepo = {
    findActiveIdsByStage: mocks.findActiveIdsByStage,
  } as unknown as CompanyRepository;
  const companyService = { promoteMany: mocks.promoteMany } as unknown as CompanyService;
  return new PipelineStageService(stageRepo, companyRepo, companyService);
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.list.mockResolvedValue(DEFAULT_ROWS);
  mocks.findActiveIdsByStage.mockResolvedValue([]);
  mocks.softDelete.mockImplementation(async (key: string) => row(key, 0));
});

describe('PipelineStageService.list', () => {
  it('flags deleted stages instead of hiding them', async () => {
    const stages = await buildService().list();
    expect(stages.find((s) => s.key === 'L3')).toMatchObject({ deleted: true });
    expect(stages.find((s) => s.key === 'L2')).toMatchObject({ deleted: false });
  });
});

describe('PipelineStageService.create', () => {
  it('inserts after the chosen stage with a generated key that is not the code', async () => {
    mocks.insertAfter.mockImplementation(async (_after: number, stage: { key: string }) =>
      row(stage.key, 3, { code: 'L2b', name: 'Expert Calls' }),
    );
    const created = await buildService().create({
      code: ' L2b ',
      name: 'Expert Calls',
      description: 'Calls',
      afterKey: 'L2',
    });

    const [afterPosition, stage] = mocks.insertAfter.mock.calls[0];
    expect(afterPosition).toBe(2);
    expect(stage).toMatchObject({ code: 'L2b', name: 'Expert Calls', description: 'Calls' });
    expect(stage.key).toMatch(/^stg-[0-9a-f]{8}$/);
    expect(stage.key).not.toContain('_TO_');
    expect(created.code).toBe('L2b');
  });

  it('rejects a code another live stage already uses, ignoring case', async () => {
    await expect(
      buildService().create({ code: 'l1', name: 'Dup', afterKey: 'L2' }),
    ).rejects.toBeInstanceOf(PipelineStageValidationError);
    expect(mocks.insertAfter).not.toHaveBeenCalled();
  });

  it('allows reusing the code of a deleted stage', async () => {
    mocks.insertAfter.mockResolvedValue(row('stg-x', 3, { code: 'L3' }));
    await buildService().create({ code: 'L3', name: 'Due Diligence', afterKey: 'L2' });
    expect(mocks.insertAfter).toHaveBeenCalled();
  });

  it('rejects a name over 40 characters and a blank code', async () => {
    const service = buildService();
    await expect(
      service.create({ code: 'L9', name: 'x'.repeat(41), afterKey: 'L2' }),
    ).rejects.toBeInstanceOf(PipelineStageValidationError);
    await expect(service.create({ code: '  ', name: 'Name', afterKey: 'L2' })).rejects.toBeInstanceOf(
      PipelineStageValidationError,
    );
  });

  it('rejects placing a stage after a deleted stage', async () => {
    await expect(
      buildService().create({ code: 'L9', name: 'Name', afterKey: 'L3' }),
    ).rejects.toBeInstanceOf(PipelineStageNotFoundError);
  });
});

describe('PipelineStageService.update', () => {
  it('lets a stage keep its own code', async () => {
    mocks.update.mockResolvedValue(row('L1', 1, { code: 'L1', name: 'Screening' }));
    await buildService().update('L1', { code: 'L1', name: 'Screening' });
    expect(mocks.update).toHaveBeenCalledWith('L1', { code: 'L1', name: 'Screening' });
  });

  it('renames the first stage — L0 is locked against delete and move, not edits', async () => {
    mocks.update.mockResolvedValue(row('L0', 0, { name: 'Origination' }));
    await buildService().update('L0', { name: 'Origination' });
    expect(mocks.update).toHaveBeenCalledWith('L0', { name: 'Origination' });
  });

  it('rejects taking another live stage’s code', async () => {
    await expect(buildService().update('L1', { code: 'L2' })).rejects.toBeInstanceOf(
      PipelineStageValidationError,
    );
  });

  it('raises not-found when the stage is deleted or unknown', async () => {
    mocks.update.mockResolvedValue(undefined);
    await expect(buildService().update('L3', { name: 'x' })).rejects.toBeInstanceOf(
      PipelineStageNotFoundError,
    );
  });
});

describe('PipelineStageService.updateMany', () => {
  const edit = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    code: key,
    name: `${key} name`,
    description: '',
    ...extra,
  });

  it('saves every edit in one repository call, trimmed, and returns the fresh list', async () => {
    const stages = await buildService().updateMany([
      edit('L0', { name: '  Sourcing  ' }),
      edit('L1', { description: 'First pass ' }),
    ]);

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith([
      { key: 'L0', code: 'L0', name: 'Sourcing', description: '' },
      { key: 'L1', code: 'L1', name: 'L1 name', description: 'First pass' },
    ]);
    expect(stages.map((s) => s.key)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
  });

  it('lets two stages swap codes in one save', async () => {
    await buildService().updateMany([edit('L1', { code: 'L2' }), edit('L2', { code: 'L1' })]);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects an edit that takes an unedited live stage’s code, ignoring case, and writes nothing', async () => {
    await expect(buildService().updateMany([edit('L1', { code: 'l4' })])).rejects.toBeInstanceOf(
      PipelineStageValidationError,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects two edits that end on the same code', async () => {
    await expect(
      buildService().updateMany([edit('L1', { code: 'X' }), edit('L2', { code: 'x' })]),
    ).rejects.toThrow(/already uses the code/);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('allows taking the code of a deleted stage', async () => {
    await buildService().updateMany([edit('L1', { code: 'L3' })]);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects the whole save when any edit is invalid', async () => {
    await expect(
      buildService().updateMany([edit('L1', { name: 'Fine' }), edit('L2', { name: '   ' })]),
    ).rejects.toThrow(/Display name is required/);
    await expect(
      buildService().updateMany([edit('L1', { name: 'x'.repeat(41) })]),
    ).rejects.toBeInstanceOf(PipelineStageValidationError);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('raises not-found for a deleted or unknown stage', async () => {
    await expect(buildService().updateMany([edit('L3')])).rejects.toBeInstanceOf(
      PipelineStageNotFoundError,
    );
    await expect(buildService().updateMany([edit('nope')])).rejects.toBeInstanceOf(
      PipelineStageNotFoundError,
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an empty list, a duplicate key and a malformed entry', async () => {
    const service = buildService();
    await expect(service.updateMany([])).rejects.toBeInstanceOf(PipelineStageValidationError);
    await expect(service.updateMany('L1')).rejects.toBeInstanceOf(PipelineStageValidationError);
    await expect(service.updateMany([edit('L1'), edit('L1')])).rejects.toThrow(/only be edited once/);
    await expect(service.updateMany([null])).rejects.toBeInstanceOf(PipelineStageValidationError);
    await expect(service.updateMany([{ code: 'L9', name: 'x' }])).rejects.toThrow(/needs its key/);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe('PipelineStageService.move', () => {
  it('swaps positions with the live neighbour, skipping deleted stages', async () => {
    mocks.list.mockResolvedValue(DEFAULT_ROWS);
    await buildService().move('L4', 'up');
    expect(mocks.setPositions).toHaveBeenCalledWith([
      { key: 'L4', position: 2 },
      { key: 'L2', position: 4 },
    ]);
  });

  it('never moves L0 and never moves a stage above it', async () => {
    const service = buildService();
    await expect(service.move('L0', 'down')).rejects.toBeInstanceOf(PipelineStageLockedError);
    await expect(service.move('L1', 'up')).rejects.toBeInstanceOf(PipelineStageLockedError);
    expect(mocks.setPositions).not.toHaveBeenCalled();
  });

  it('rejects moving the last stage down', async () => {
    await expect(buildService().move('L4', 'down')).rejects.toBeInstanceOf(
      PipelineStageValidationError,
    );
  });
});

describe('PipelineStageService.delete', () => {
  it('moves the active deals to the target, then soft-deletes the stage', async () => {
    mocks.findActiveIdsByStage.mockResolvedValueOnce(['c1', 'c2']).mockResolvedValueOnce([]);
    const result = await buildService().delete('L2', 'L4');

    expect(mocks.promoteMany).toHaveBeenCalledWith(
      [
        { id: 'c1', currentStage: 'L2' },
        { id: 'c2', currentStage: 'L2' },
      ],
      'L4',
    );
    expect(mocks.softDelete).toHaveBeenCalledWith('L2');
    expect(mocks.promoteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.softDelete.mock.invocationCallOrder[0],
    );
    expect(result).toEqual({ moved: 2 });
  });

  it('requires a target when the stage has active deals, and deletes nothing', async () => {
    mocks.findActiveIdsByStage.mockResolvedValue(['c1']);
    await expect(buildService().delete('L2')).rejects.toBeInstanceOf(PipelineStageValidationError);
    expect(mocks.softDelete).not.toHaveBeenCalled();
  });

  it('deletes an empty stage without a target', async () => {
    await expect(buildService().delete('L2')).resolves.toEqual({ moved: 0 });
    expect(mocks.promoteMany).not.toHaveBeenCalled();
  });

  it('sweeps a deal that landed in the stage while it was being deleted', async () => {
    mocks.findActiveIdsByStage.mockResolvedValueOnce([]).mockResolvedValueOnce(['late']);
    await expect(buildService().delete('L2', 'L4')).resolves.toEqual({ moved: 1 });
    expect(mocks.promoteMany).toHaveBeenCalledWith([{ id: 'late', currentStage: 'L2' }], 'L4');
  });

  it('never deletes L0', async () => {
    await expect(buildService().delete('L0', 'L1')).rejects.toBeInstanceOf(PipelineStageLockedError);
  });

  it('rejects a deleted or self target', async () => {
    const service = buildService();
    await expect(service.delete('L2', 'L3')).rejects.toBeInstanceOf(PipelineStageNotFoundError);
    await expect(service.delete('L2', 'L2')).rejects.toBeInstanceOf(PipelineStageValidationError);
    expect(mocks.softDelete).not.toHaveBeenCalled();
  });
});
