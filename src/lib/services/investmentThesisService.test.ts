import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestmentThesisRepository } from '@/lib/repositories';
import { InvestmentThesisService } from './investmentThesisService';
import type { MarketScanningRoutineService } from './marketScanningRoutineService';

function makeRepoStub(): InvestmentThesisRepository {
  return {
    findActive: vi.fn(),
    findActiveList: vi.fn(),
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
