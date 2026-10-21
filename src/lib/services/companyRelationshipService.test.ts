import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyRepository } from '@/lib/repositories';
import type { CompanyService } from './companyService';
import type { CompanyGraphService } from './companyGraphService';
import {
  CompanyNotFoundError,
  CompanyRelationshipService,
  InvalidCombineError,
} from './companyRelationshipService';

const findByNameFuzzy = vi.fn();
const findById = vi.fn();
const update = vi.fn();
const create = vi.fn();
const deleteCompany = vi.fn();
const relateCompanies = vi.fn();
const reassignAndDeleteNode = vi.fn();

function makeService(): CompanyRelationshipService {
  return new CompanyRelationshipService(
    { findByNameFuzzy, findById, update } as unknown as CompanyRepository,
    { create, delete: deleteCompany } as unknown as CompanyService,
    { relateCompanies, reassignAndDeleteNode } as unknown as CompanyGraphService,
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

describe('CompanyRelationshipService.linkRelatedCompanies', () => {
  let service: CompanyRelationshipService;
  let linkByName: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    service = makeService();
    linkByName = vi.spyOn(service, 'linkByName').mockImplementation(async (input) => ({
      source: { row: { id: 'src', target: input.sourceName }, created: false },
      target: { row: { id: 'tgt', target: input.targetName }, created: input.targetName === 'Gamma' },
    }) as never);
  });

  it('links each related company from the analysed company', async () => {
    const lines = await service.linkRelatedCompanies('Acme', [
      { name: 'Beta', relation_type: 'SUPPLIER', notes: ' wafers ' },
      { name: 'Gamma', relation_type: 'INVESTED_IN' },
    ]);

    expect(linkByName).toHaveBeenCalledTimes(2);
    expect(linkByName).toHaveBeenNthCalledWith(1, {
      sourceName: 'Acme',
      targetName: 'Beta',
      type: 'SUPPLIER',
      notes: 'wafers',
      evidence: undefined,
    });
    expect(lines).toEqual(['"Beta" (SUPPLIER)', '"Gamma" (INVESTED_IN, new discovered)']);
  });

  it('skips blank names and the analysed company itself', async () => {
    const lines = await service.linkRelatedCompanies('Acme', [
      { name: ' acme ', relation_type: 'PARTNER' },
      { name: '  ', relation_type: 'PARTNER' },
    ]);

    expect(linkByName).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('reports a failed link and keeps linking the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    linkByName.mockRejectedValueOnce(new Error('neo4j down'));

    const lines = await service.linkRelatedCompanies('Acme', [
      { name: 'Beta', relation_type: 'SUPPLIER' },
      { name: 'Delta', relation_type: 'PARTNER' },
    ]);

    expect(lines).toEqual(['"Beta" — link failed: neo4j down', '"Delta" (PARTNER)']);
  });
});

describe('CompanyRelationshipService.combineCompanies', () => {
  let service: CompanyRelationshipService;

  beforeEach(() => {
    findById.mockReset();
    update.mockReset().mockResolvedValue([]);
    deleteCompany.mockReset().mockResolvedValue(undefined);
    reassignAndDeleteNode.mockReset().mockResolvedValue(undefined);
    service = makeService();
  });

  it('reroutes edges, records aliases on main, and deletes the absorbed rows', async () => {
    findById.mockImplementation(async (id: string) => {
      const rows: Record<string, unknown> = {
        main: { id: 'main', target: 'Acme', aliases: [] },
        dup1: { id: 'dup1', target: 'Acme Corp', aliases: ['ACME Inc'] },
        dup2: { id: 'dup2', target: 'Acme Limited', aliases: [] },
      };
      return rows[id];
    });

    const result = await service.combineCompanies({
      mainId: 'main',
      otherIds: ['dup1', 'dup2'],
    });

    // Aliases: absorbed names + their aliases, deduped, excluding the main name.
    expect(update).toHaveBeenCalledWith('main', {
      aliases: ['Acme Corp', 'ACME Inc', 'Acme Limited'],
    });
    // aliases persisted BEFORE any node is rerouted (mirrors main node first).
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      reassignAndDeleteNode.mock.invocationCallOrder[0],
    );
    // Each absorbed company is rerouted to main and deleted.
    expect(reassignAndDeleteNode).toHaveBeenCalledWith('dup1', 'main');
    expect(reassignAndDeleteNode).toHaveBeenCalledWith('dup2', 'main');
    expect(deleteCompany).toHaveBeenCalledWith('dup1');
    expect(deleteCompany).toHaveBeenCalledWith('dup2');
    expect(result).toEqual({
      mainId: 'main',
      combined: 2,
      aliases: ['Acme Corp', 'ACME Inc', 'Acme Limited'],
    });
  });

  it('drops the main id and duplicates from the others list', async () => {
    findById.mockImplementation(async (id: string) => ({ id, target: id, aliases: [] }));

    await service.combineCompanies({
      mainId: 'main',
      otherIds: ['main', 'dup1', 'dup1', ''],
    });

    expect(reassignAndDeleteNode).toHaveBeenCalledTimes(1);
    expect(reassignAndDeleteNode).toHaveBeenCalledWith('dup1', 'main');
  });

  it('excludes the main company name from the alias list case-insensitively', async () => {
    findById.mockImplementation(async (id: string) => {
      const rows: Record<string, unknown> = {
        main: { id: 'main', target: 'Acme', aliases: [] },
        dup1: { id: 'dup1', target: 'ACME', aliases: ['Acme'] },
      };
      return rows[id];
    });

    const result = await service.combineCompanies({ mainId: 'main', otherIds: ['dup1'] });

    expect(result.aliases).toEqual([]);
    expect(update).toHaveBeenCalledWith('main', { aliases: [] });
  });

  it('throws InvalidCombineError when no other companies are given', async () => {
    await expect(
      service.combineCompanies({ mainId: 'main', otherIds: [] }),
    ).rejects.toBeInstanceOf(InvalidCombineError);
    expect(findById).not.toHaveBeenCalled();
  });

  it('throws InvalidCombineError when mainId is blank', async () => {
    await expect(
      service.combineCompanies({ mainId: '   ', otherIds: ['dup1'] }),
    ).rejects.toBeInstanceOf(InvalidCombineError);
  });

  it('throws CompanyNotFoundError when a company does not exist', async () => {
    findById.mockImplementation(async (id: string) => {
      if (id === 'main') return { id: 'main', target: 'Acme', aliases: [] };
      throw new Error(`Company ${id} not found`);
    });

    await expect(
      service.combineCompanies({ mainId: 'main', otherIds: ['ghost'] }),
    ).rejects.toBeInstanceOf(CompanyNotFoundError);
    expect(reassignAndDeleteNode).not.toHaveBeenCalled();
  });
});
