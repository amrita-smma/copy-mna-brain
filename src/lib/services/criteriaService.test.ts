import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CriteriaRepository } from '@/lib/repositories';
import { CriteriaService } from './criteriaService';

function makeRepoStub(): CriteriaRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue({ id: 'crit-1' }),
    update: vi.fn().mockResolvedValue({ id: 'crit-1' }),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as CriteriaRepository;
}

describe('CriteriaService.findAll', () => {
  let repo: CriteriaRepository;
  let service: CriteriaService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new CriteriaService(repo);
  });

  it('passes the thesis id through to scope criteria to a Track', async () => {
    await service.findAll('thesis-1');
    expect(repo.findAll).toHaveBeenCalledWith('thesis-1');
  });

  it('passes undefined when no thesis id is given (all criteria)', async () => {
    await service.findAll();
    expect(repo.findAll).toHaveBeenCalledWith(undefined);
  });
});

describe('CriteriaService.create', () => {
  let repo: CriteriaRepository;
  let service: CriteriaService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new CriteriaService(repo);
  });

  it('assigns the criterion to the given Track', async () => {
    await service.create('Asia Revenue', 'Revenue from Asia > 30%', 'thesis-1');
    expect(repo.insert).toHaveBeenCalledWith({
      name: 'Asia Revenue',
      prompt: 'Revenue from Asia > 30%',
      investment_thesis_id: 'thesis-1',
      must_pass: false,
    });
  });

  it('stores a must-pass criterion', async () => {
    await service.create('Asia Revenue', 'Revenue from Asia > 30%', 'thesis-1', true);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ must_pass: true }));
  });
});

describe('CriteriaService.update', () => {
  let repo: CriteriaRepository;
  let service: CriteriaService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new CriteriaService(repo);
  });

  it('leaves the must-pass flag alone when none is given', async () => {
    await service.update('crit-1', 'Name', 'Prompt');
    expect(repo.update).toHaveBeenCalledWith('crit-1', { name: 'Name', prompt: 'Prompt' });
  });

  it('sets the must-pass flag when given', async () => {
    await service.update('crit-1', 'Name', 'Prompt', false);
    expect(repo.update).toHaveBeenCalledWith('crit-1', {
      name: 'Name',
      prompt: 'Prompt',
      must_pass: false,
    });
  });
});
