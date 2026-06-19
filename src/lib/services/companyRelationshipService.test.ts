import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyRepository } from '@/lib/repositories';
import type { CompanyService } from './companyService';
import type { CompanyGraphService } from './companyGraphService';
import { CompanyRelationshipService } from './companyRelationshipService';

const findByNameFuzzy = vi.fn();
const create = vi.fn();
const relateCompanies = vi.fn();

function makeService(): CompanyRelationshipService {
  return new CompanyRelationshipService(
    { findByNameFuzzy } as unknown as CompanyRepository,
    { create } as unknown as CompanyService,
    { relateCompanies } as unknown as CompanyGraphService,
  );
}

describe('CompanyRelationshipService.linkByName', () => {
  let service: CompanyRelationshipService;

  beforeEach(() => {
    findByNameFuzzy.mockReset();
    create.mockReset();
    relateCompanies.mockReset().mockResolvedValue(undefined);
    service = makeService();
  });

  it('links two existing companies without creating any rows', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({ id: 'src-1', target: 'Acme' })
      .mockResolvedValueOnce({ id: 'tgt-1', target: 'Beta' });

    const result = await service.linkByName({
      sourceName: 'Acme',
      targetName: 'Beta',
      type: 'INVESTED_IN',
      notes: 'Series B lead',
    });

    expect(create).not.toHaveBeenCalled();
    expect(relateCompanies).toHaveBeenCalledWith({
      source: { id: 'src-1', target: 'Acme' },
      target: { id: 'tgt-1', target: 'Beta' },
      type: 'INVESTED_IN',
      notes: 'Series B lead',
      evidence: undefined,
      date: undefined,
    });
    expect(result.source.created).toBe(false);
    expect(result.target.created).toBe(false);
  });

  it('creates a discovered company for an unmatched side and links it', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({ id: 'src-1', target: 'Acme' })
      .mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: 'new-1', target: 'Ghost Corp' });

    const result = await service.linkByName({
      sourceName: 'Acme',
      targetName: 'Ghost Corp',
      type: 'SUPPLIER',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'Ghost Corp',
        pipeline_stage: 'discovered',
        status: 'active',
      }),
      'CREATED_AS_DISCOVERED',
    );
    expect(result.target).toEqual({
      row: { id: 'new-1', target: 'Ghost Corp' },
      created: true,
    });
    expect(relateCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { id: 'src-1', target: 'Acme' },
        target: { id: 'new-1', target: 'Ghost Corp' },
        type: 'SUPPLIER',
      }),
    );
  });

  it('trims the name before matching and creating', async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'x', target: 'Trimmed' });

    await service.resolveOrCreateDiscovered('  Trimmed  ');

    expect(findByNameFuzzy).toHaveBeenCalledWith('Trimmed');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Trimmed' }),
      'CREATED_AS_DISCOVERED',
    );
  });
});
