import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('drizzle/migrations/20260911000000_fund_ledger_v2.sql', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../drizzle/migrations/20260911000000_fund_ledger_v2.sql',
  );
  const journalPath = path.resolve(__dirname, '../drizzle/migrations/meta/_journal.json');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string; version: string; breakpoints: boolean }>;
  };

  it('is registered in drizzle journal metadata as clean-slate schema without unreleased backfill or legacy cleanup', () => {
    const tags = journal.entries.map((entry) => entry.tag);
    const v2Index = tags.indexOf('20260911000000_fund_ledger_v2');
    const backfillIndex = tags.indexOf('20260824000002_fund_ledger_v2_backfill');
    const cleanupIndex = tags.indexOf('20260826000000_guarded_legacy_fund_schema_cleanup');

    expect(v2Index).toBeGreaterThan(-1);
    expect(backfillIndex).toBe(-1);
    expect(cleanupIndex).toBe(-1);
    expect(journal.entries[v2Index]).toMatchObject({ version: '7', breakpoints: true });
  });

  it('does not install append-only update/delete triggers', () => {
    expect(sql).not.toContain('fl_ledger_entries_append_only');
    expect(sql).not.toContain('fl_ledger_entries_prevent_update_delete');
    expect(sql).not.toContain('fl_business_events_append_only');
    expect(sql).not.toContain('fl_ledger_entry_allocations_append_only');
  });

  it('keeps ledger business rules out of the database migration', () => {
    expect(sql).not.toContain('fl_ledger_entries_delta_matrix_chk');
    expect(sql).not.toContain('fl_ledger_entries_counterparty_chk');
    expect(sql).not.toContain('fl_validate_commitment_transfer_event');
    expect(sql).not.toContain('fl_ledger_entries_commitment_transfer_balanced');
  });

  it('creates holder_source_of_fund_id on positions as part of the natural key without SPV dimension', () => {
    expect(sql).toContain('holder_source_of_fund_id UUID REFERENCES fl_funding_sources(id) ON DELETE RESTRICT');
    expect(sql).toContain(
      'UNIQUE NULLS NOT DISTINCT (holder_investor_id, holder_fund_id, fund_id, asset_id, holder_source_of_fund_id)',
    );
    expect(sql).toContain('CREATE INDEX idx_fl_positions_holder_source_of_fund_id');
    expect(sql).not.toContain('fl_spvs');
    expect(sql).not.toContain('custodian_spv_id');
  });

});
