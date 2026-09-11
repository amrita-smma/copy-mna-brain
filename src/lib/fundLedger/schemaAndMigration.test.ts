import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { flAssets, flFundingSources, flFunds, flInvestors } from '@/lib/db/schema';
import {
  FlAssetRepository,
  FlFundRepository,
  FlFundingSourceRepository,
  FlInvestorRepository,
} from '@/lib/repositories';
import { normalizeCanonicalName } from './normalizeIdentity';

describe('Fund Ledger canonical master identity', () => {
  const baseMigration = fs.readFileSync(
    path.join(process.cwd(), 'drizzle/migrations/20260911000000_fund_ledger_v2.sql'),
    'utf8',
  );

  it.each([
    ['fl_investors', flInvestors.canonical_name],
    ['fl_funds', flFunds.canonical_name],
    ['fl_assets', flAssets.canonical_name],
    ['fl_funding_sources', flFundingSources.canonical_name],
  ])('defines canonical_name and workspace uniqueness when creating %s', (table, column) => {
    expect(column.name).toBe('canonical_name');
    expect(baseMigration).toContain(`CREATE TABLE ${table}`);
    expect(baseMigration).toContain(
      `CREATE UNIQUE INDEX ${table}_workspace_canonical_name_uniq`,
    );
    expect(baseMigration).toContain(`ON ${table} (workspace_id, canonical_name)`);
  });

  it('does not carry a post-creation backfill or dedup migration', () => {
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          'drizzle/migrations/20260831000002_deduplicate_master_data_and_add_unique_constraints.sql',
        ),
      ),
    ).toBe(false);
  });

  it.each([
    ['asset', FlAssetRepository, { name: '赛德特 生物制药 有限公司', asset_kind: 'equity' }],
    ['fund', FlFundRepository, { name: '南京 瑞满 基金', ownership_basis: 'commitment' }],
    ['investor', FlInvestorRepository, { name: '南京 国资 投资主体', investor_type: 'institution' }],
    ['funding source', FlFundingSourceRepository, { name: 'TREASURY  POOL' }],
  ])('populates canonical_name for a new %s', async (_label, Repository, input) => {
    let insertedValues: Record<string, unknown> | undefined;
    const mockDb: any = {
      insert: vi.fn(() => ({
        values: vi.fn((values) => {
          insertedValues = values;
          return { returning: vi.fn().mockResolvedValue([{ id: 'row-1', ...values }]) };
        }),
      })),
    };

    const repo = new Repository(mockDb as never);
    await repo.create({ workspace_id: 'ws-1', ...input } as never);

    expect(insertedValues?.canonical_name).toBe(normalizeCanonicalName(input.name));
  });
});
