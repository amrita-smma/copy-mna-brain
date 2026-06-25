import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestmentThesisRepository } from '@/lib/repositories';
import { InvestmentThesisService } from './investmentThesisService';
import type { MarketScanningRoutineService } from './marketScanningRoutineService';

function makeRepoStub(): InvestmentThesisRepository {
  return {
    findActive: vi.fn(),
    findActiveList: vi.fn(),
    findAll: vi.fn().mockResolvedValue([{ id: 'thesis-1' }, { id: 'thesis-2' }]),
    deleteById: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    updateMany: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue({ id: 'thesis-new', scan_frequency: 'weekly' }),
    update: vi.fn().mockResolvedValue({ id: 'thesis-1', scan_frequency: 'monthly' }),
  } as unknown as InvestmentThesisRepository;
}

function makeRoutineStub(): MarketScanningRoutineService {
  return { sync: vi.fn().mockResolvedValue(undefined) } as unknown as MarketScanningRoutineService;
}

describe('InvestmentThesisService.upsert', () => {
  let repo: InvestmentThesisRepository;
  let routineService: MarketScanningRoutineService;
  let service: InvestmentThesisService;

  beforeEach(() => {
    repo = makeRepoStub();
    routineService = makeRoutineStub();
    service = new InvestmentThesisService(repo, routineService);
  });

  it('calls update when an id is provided', async () => {
    await service.upsert({ id: 'thesis-1', title: 'Growth', content: 'SaaS focus' });

    expect(repo.update).toHaveBeenCalledWith('thesis-1', expect.objectContaining({ title: 'Growth', content: 'SaaS focus' }));
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('calls insert when no id is provided', async () => {
    await service.upsert({ title: 'Growth', content: 'SaaS focus' });

    expect(repo.insert).toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('defaults title to "Default Thesis" when not provided on insert', async () => {
    await service.upsert({ content: 'Some content' });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Default Thesis' }),
    );
  });

  it('defaults content to empty string when not provided on insert (nullish coalescing)', async () => {
    await service.upsert({ title: 'Growth' });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: '' }),
    );
  });

  it('preserves explicit empty string content on insert', async () => {
    await service.upsert({ title: 'Growth', content: '' });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: '' }),
    );
  });

  it('syncs the market-scanning routine with the saved thesis cadence', async () => {
    await service.upsert({ id: 'thesis-1', scan_frequency: 'monthly' });

    expect(routineService.sync).toHaveBeenCalledWith('monthly');
  });

  it('still returns the saved thesis when the routine sync throws', async () => {
    (routineService.sync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('routine down'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.upsert({ id: 'thesis-1', scan_frequency: 'monthly' });

    expect(result).toEqual(expect.objectContaining({ id: 'thesis-1' }));
    errSpy.mockRestore();
  });
});

describe('InvestmentThesisService.list / remove', () => {
  let repo: InvestmentThesisRepository;
  let service: InvestmentThesisService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new InvestmentThesisService(repo, makeRoutineStub());
  });

  it('list delegates to the repository findAll', async () => {
    const result = await service.list();

    expect(repo.findAll).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'thesis-1' }, { id: 'thesis-2' }]);
  });

  it('remove delegates to the repository deleteById', async () => {
    await service.remove('thesis-1');

    expect(repo.deleteById).toHaveBeenCalledWith('thesis-1');
  });
});

describe('InvestmentThesisService.configureScan', () => {
  let repo: InvestmentThesisRepository;
  let routineService: MarketScanningRoutineService;
  let service: InvestmentThesisService;

  beforeEach(() => {
    repo = makeRepoStub();
    routineService = makeRoutineStub();
    service = new InvestmentThesisService(repo, routineService);
  });

  it('sets the active set, applies cadence to the selected theses, and syncs the routine', async () => {
    await service.configureScan({
      thesisIds: ['thesis-1', 'thesis-2'],
      scan_frequency: 'monthly',
      sources_count: 8,
    });

    expect(repo.setActive).toHaveBeenCalledWith(['thesis-1', 'thesis-2']);
    expect(repo.updateMany).toHaveBeenCalledWith(['thesis-1', 'thesis-2'], {
      scan_frequency: 'monthly',
      sources_count: 8,
    });
    expect(routineService.sync).toHaveBeenCalledWith('monthly');
  });

  it('deactivates all theses without applying cadence when the set is empty', async () => {
    await service.configureScan({ thesisIds: [], scan_frequency: 'weekly' });

    expect(repo.setActive).toHaveBeenCalledWith([]);
    expect(repo.updateMany).not.toHaveBeenCalled();
  });

  it('returns the full thesis list after configuring', async () => {
    const result = await service.configureScan({ thesisIds: ['thesis-1'] });

    expect(repo.findAll).toHaveBeenCalled();
    expect(result).toEqual([{ id: 'thesis-1' }, { id: 'thesis-2' }]);
  });

  it('still resolves when the routine sync throws', async () => {
    (routineService.sync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('routine down'),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      service.configureScan({ thesisIds: ['thesis-1'] }),
    ).resolves.toBeDefined();
    errSpy.mockRestore();
  });
});
