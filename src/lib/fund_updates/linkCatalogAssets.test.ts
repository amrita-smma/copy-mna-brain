import { describe, expect, it } from 'vitest';
import {
  assetCodesForCatalogName,
  hydrateParsedAssetsFromEvents,
} from './linkCatalogAssets';
import type {
  ParsedAsset,
  ProposedEntity,
  ProposedEvent,
} from './types';

function createSampleAsset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: 'AST-1',
    name: 'TechCo A',
    legalName: 'TechCo A Ltd',
    country: 'Singapore',
    investmentTypeLabel: 'Direct',
    assetType: 'direct_investment',
    fund: 'Startech Fund I',
    entity: 'Holding Corp 1',
    fundingSource: 'DCA',
    fundingSourceRaw: 'DCA',
    entryDate: '2021-01-01',
    stakePct: 10,
    commitmentAmount: 100000,
    dealType: null,
    mgmtFeeRatePct: null,
    sector: 'Technology',
    subSector: 'SaaS',
    instrument: 'Preferred',
    sharesOutstanding: 1000,
    sourceRef: 'REF-1',
    vintageYear: 2021,
    valuations: [],
    currentPricePerShare: 10,
    txns: [],
    ...overrides,
  };
}

describe('hydrateParsedAssetsFromEvents', () => {
  it('returns empty array when given empty or nullish assets', () => {
    expect(hydrateParsedAssetsFromEvents([])).toEqual([]);
    expect(hydrateParsedAssetsFromEvents(null as unknown as ParsedAsset[])).toEqual([]);
  });

  it('clones assets without mutating the original input objects', () => {
    const originalAsset = createSampleAsset({ entity: '', fund: '' });
    const entities: ProposedEntity[] = [
      {
        proposalId: 'ent-inv-1',
        entityType: 'investor',
        originalName: 'Asia Growth LP',
        aliases: [],
        sourceLocations: [],
        warnings: [],
      },
    ];
    const events: ProposedEvent[] = [
      {
        proposalId: 'ev-1',
        eventType: 'asset_investment',
        fromEntityRef: 'Asia Growth LP',
        toEntityRef: 'TechCo A',
        relatedFundRef: 'Startech Fund I',
        sourceLocation: { sheet: 'Sheet1', row: 2 },
        warnings: [],
      },
    ];

    const result = hydrateParsedAssetsFromEvents([originalAsset], entities, events);

    expect(result).toHaveLength(1);
    expect(result[0].entity).toBe('Asia Growth LP');
    expect(result[0].fund).toBe('Startech Fund I');
    expect(originalAsset.entity).toBe('');
    expect(originalAsset.fund).toBe('');
  });

  it('hydrates empty entity and fund from first matching event', () => {
    const asset = createSampleAsset({
      code: 'AST-10',
      name: 'Alpha Portco',
      entity: '',
      fund: '',
    });

    const entities: ProposedEntity[] = [
      {
        proposalId: 'ent-lp-1',
        entityType: 'institutional_investor',
        originalName: 'Global LP Fund',
        englishName: 'Global LP Fund Ltd',
        aliases: [],
        sourceLocations: [],
        warnings: [],
      },
      {
        proposalId: 'ent-fund-1',
        entityType: 'fund',
        originalName: 'Venture Vehicle I',
        aliases: [],
        sourceLocations: [],
        warnings: [],
      },
    ];

    const events: ProposedEvent[] = [
      {
        proposalId: 'ev-unrelated',
        eventType: 'capital_contribution',
        fromEntityRef: 'Global LP Fund',
        toEntityRef: 'Venture Vehicle I',
        sourceLocation: { sheet: 'Sheet1', row: 1 },
        warnings: [],
      },
      {
        proposalId: 'ev-match',
        eventType: 'asset_investment',
        fromEntityRef: 'Global LP Fund',
        toEntityRef: 'Alpha Portco',
        relatedFundRef: 'Venture Vehicle I',
        sourceLocation: { sheet: 'Sheet1', row: 2 },
        warnings: [],
      },
    ];

    const [hydrated] = hydrateParsedAssetsFromEvents([asset], entities, events);
    expect(hydrated.entity).toBe('Global LP Fund');
    expect(hydrated.fund).toBe('Venture Vehicle I');
  });

  it('resolves fund from fund entity ref when relatedFundRef is absent', () => {
    const asset = createSampleAsset({
      code: 'AST-20',
      name: 'Beta Co',
      entity: 'Existing Entity',
      fund: '',
    });

    const entities: ProposedEntity[] = [
      {
        proposalId: 'ent-f-1',
        entityType: 'fund',
        originalName: 'Main Fund Vehicle',
        aliases: [],
        sourceLocations: [],
        warnings: [],
      },
    ];

    const events: ProposedEvent[] = [
      {
        proposalId: 'ev-fund-invest',
        eventType: 'asset_investment',
        fromEntityRef: 'Main Fund Vehicle',
        toEntityRef: 'Beta Co',
        sourceLocation: { sheet: 'Sheet1', row: 2 },
        warnings: [],
      },
    ];

    const [hydrated] = hydrateParsedAssetsFromEvents([asset], entities, events);
    expect(hydrated.entity).toBe('Existing Entity');
    expect(hydrated.fund).toBe('Main Fund Vehicle');
  });
});

describe('assetCodesForCatalogName', () => {
  it('returns empty array on empty catalog name or empty assets', () => {
    expect(
      assetCodesForCatalogName({
        catalogName: '',
        kind: 'investor',
        assets: [createSampleAsset()],
      }),
    ).toEqual([]);

    expect(
      assetCodesForCatalogName({
        catalogName: 'Startech',
        kind: 'fund',
        assets: [],
      }),
    ).toEqual([]);
  });

  describe('direct field matching', () => {
    it('matches investor catalog by asset.entity case-insensitively with trim', () => {
      const asset1 = createSampleAsset({ code: 'A1', entity: '  Asia Star Fund Ltd  ' });
      const asset2 = createSampleAsset({ code: 'A2', entity: 'Other Investor' });

      const codes = assetCodesForCatalogName({
        catalogName: 'asia star fund ltd',
        kind: 'investor',
        assets: [asset1, asset2],
      });

      expect(codes).toEqual(['A1']);
    });

    it('matches fund catalog by asset.fund case-insensitively with trim', () => {
      const asset1 = createSampleAsset({ code: 'A1', fund: 'Fund I' });
      const asset2 = createSampleAsset({ code: 'A2', fund: 'Fund II' });
      const asset3 = createSampleAsset({ code: 'A3', fund: ' fund i ' });

      const codes = assetCodesForCatalogName({
        catalogName: 'FUND I',
        kind: 'fund',
        assets: [asset1, asset2, asset3],
      });

      expect(codes).toEqual(['A1', 'A3']);
    });

    it('matches source catalog by asset.fundingSource and fundingSourceRaw', () => {
      const asset1 = createSampleAsset({ code: 'A1', fundingSource: 'DCA', fundingSourceRaw: 'DCA' });
      const asset2 = createSampleAsset({ code: 'A2', fundingSource: 'Direct', fundingSourceRaw: 'Wire Transfer' });

      expect(
        assetCodesForCatalogName({
          catalogName: 'dca',
          kind: 'source',
          assets: [asset1, asset2],
        }),
      ).toEqual(['A1']);

      expect(
        assetCodesForCatalogName({
          catalogName: 'wire transfer',
          kind: 'source',
          assets: [asset1, asset2],
        }),
      ).toEqual(['A2']);
    });

    it('matches asset catalog by asset.code or asset.name', () => {
      const asset1 = createSampleAsset({ code: 'GOTO', name: 'GOTO Group' });

      expect(
        assetCodesForCatalogName({
          catalogName: 'goto',
          kind: 'asset',
          assets: [asset1],
        }),
      ).toEqual(['GOTO']);

      expect(
        assetCodesForCatalogName({
          catalogName: 'goto group',
          kind: 'asset',
          assets: [asset1],
        }),
      ).toEqual(['GOTO']);
    });
  });

  describe('direct event matching', () => {
    it('links asset when event references catalog entity and asset directly', () => {
      const asset = createSampleAsset({ code: 'A-DIR', name: 'Direct Portco', entity: '', fund: '' });
      const entities: ProposedEntity[] = [
        {
          proposalId: 'lp-direct',
          entityType: 'investor',
          originalName: 'Direct Investor LP',
          englishName: 'Direct Investor LP Ltd',
          aliases: ['DILP'],
          sourceLocations: [],
          warnings: [],
        },
      ];
      const events: ProposedEvent[] = [
        {
          proposalId: 'ev-1',
          eventType: 'asset_investment',
          fromEntityRef: 'DILP',
          toEntityRef: 'Direct Portco',
          sourceLocation: { sheet: 'Sheet1', row: 1 },
          warnings: [],
        },
      ];

      const codes = assetCodesForCatalogName({
        catalogName: 'Direct Investor LP',
        kind: 'investor',
        assets: [asset],
        entities,
        events,
      });

      expect(codes).toEqual(['A-DIR']);
    });
  });

  describe('investor via fund matching (流水明细 scenario)', () => {
    it('links investor to all assets in the fund through capital contribution events', () => {
      const asset1 = createSampleAsset({ code: 'P1', name: 'Portco One', fund: 'Fund F', entity: '' });
      const asset2 = createSampleAsset({ code: 'P2', name: 'Portco Two', fund: 'Fund F', entity: '' });
      const asset3 = createSampleAsset({ code: 'P3', name: 'Portco Three', fund: 'Other Fund G', entity: '' });

      const entities: ProposedEntity[] = [
        {
          proposalId: 'lp-41',
          entityType: 'institutional_investor',
          originalName: 'Strategic LP 41',
          aliases: [],
          sourceLocations: [],
          warnings: [],
        },
        {
          proposalId: 'fund-f',
          entityType: 'fund',
          originalName: 'Fund F',
          aliases: [],
          sourceLocations: [],
          warnings: [],
        },
      ];

      const events: ProposedEvent[] = [
        {
          proposalId: 'ev-contribution',
          eventType: 'capital_contribution',
          fromEntityRef: 'Strategic LP 41',
          toEntityRef: 'Fund F',
          relatedFundRef: 'Fund F',
          sourceLocation: { sheet: 'Sheet1', row: 1 },
          warnings: [],
        },
      ];

      const codes = assetCodesForCatalogName({
        catalogName: 'Strategic LP 41',
        kind: 'investor',
        assets: [asset1, asset2, asset3],
        entities,
        events,
      });

      // Links to P1 and P2 in Fund F, but not P3 in Other Fund G
      expect(codes).toEqual(['P1', 'P2']);
    });

    it('does not link to assets when investor contributed to a different fund', () => {
      const asset1 = createSampleAsset({ code: 'P1', name: 'Portco One', fund: 'Fund F', entity: '' });

      const entities: ProposedEntity[] = [
        {
          proposalId: 'lp-x',
          entityType: 'individual_investor',
          originalName: 'Individual Investor X',
          aliases: [],
          sourceLocations: [],
          warnings: [],
        },
      ];

      const events: ProposedEvent[] = [
        {
          proposalId: 'ev-other-contribution',
          eventType: 'capital_contribution',
          fromEntityRef: 'Individual Investor X',
          relatedFundRef: 'Different Fund H',
          sourceLocation: { sheet: 'Sheet1', row: 1 },
          warnings: [],
        },
      ];

      const codes = assetCodesForCatalogName({
        catalogName: 'Individual Investor X',
        kind: 'investor',
        assets: [asset1],
        entities,
        events,
      });

      expect(codes).toEqual([]);
    });

    it('deduplicates asset codes across direct field and event links', () => {
      const asset1 = createSampleAsset({
        code: 'P1',
        name: 'Portco One',
        fund: 'Fund F',
        entity: 'Investor Alpha',
      });

      const entities: ProposedEntity[] = [
        {
          proposalId: 'lp-alpha',
          entityType: 'investor',
          originalName: 'Investor Alpha',
          aliases: [],
          sourceLocations: [],
          warnings: [],
        },
      ];

      const events: ProposedEvent[] = [
        {
          proposalId: 'ev-1',
          eventType: 'capital_contribution',
          fromEntityRef: 'Investor Alpha',
          relatedFundRef: 'Fund F',
          sourceLocation: { sheet: 'Sheet1', row: 1 },
          warnings: [],
        },
        {
          proposalId: 'ev-2',
          eventType: 'asset_investment',
          fromEntityRef: 'Investor Alpha',
          toEntityRef: 'Portco One',
          sourceLocation: { sheet: 'Sheet1', row: 2 },
          warnings: [],
        },
      ];

      const codes = assetCodesForCatalogName({
        catalogName: 'Investor Alpha',
        kind: 'investor',
        assets: [asset1],
        entities,
        events,
      });

      expect(codes).toEqual(['P1']);
    });
  });
});
