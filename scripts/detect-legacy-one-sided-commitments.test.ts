import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('scripts/detect-legacy-one-sided-commitments.sql', () => {
  const sqlPath = path.resolve(__dirname, 'detect-legacy-one-sided-commitments.sql');
  const sqlContent = fs.readFileSync(sqlPath, 'utf-8');

  it('exists and has non-empty content', () => {
    expect(sqlContent.length).toBeGreaterThan(0);
  });

  it('is strictly read-only and does not contain mutation or deletion statements', () => {
    // Strip comments to inspect executable SQL statements
    const sqlCodeOnly = sqlContent
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .toUpperCase();

    expect(sqlCodeOnly).not.toMatch(/\bDELETE\b/);
    expect(sqlCodeOnly).not.toMatch(/\bDROP\b/);
    expect(sqlCodeOnly).not.toMatch(/\bTRUNCATE\b/);
    expect(sqlCodeOnly).not.toMatch(/\bUPDATE\b/);
    expect(sqlCodeOnly).not.toMatch(/\bINSERT\b/);
    expect(sqlCodeOnly).not.toMatch(/\bALTER\b/);
  });

  it('selects workspace, business event, entry/position, event date, commitment delta, notes, source record, and reversal status', () => {
    expect(sqlContent).toContain('workspace_id');
    expect(sqlContent).toContain('business_event_id');
    expect(sqlContent).toContain('ledger_entry_id');
    expect(sqlContent).toContain('position_id');
    expect(sqlContent).toContain('entry_date');
    expect(sqlContent).toContain('commitment_delta');
    expect(sqlContent).toContain('entry_notes');
    expect(sqlContent).toContain('source_record_id');
    expect(sqlContent).toContain('entry_is_reversal');
  });

  it('filters rows where entry_type is commitment and notes match Transferred Commitment or Counterparty:', () => {
    expect(sqlContent).toContain("le.entry_type = 'commitment'");
    expect(sqlContent).toContain("le.notes ILIKE '%Transferred Commitment%'");
    expect(sqlContent).toContain("le.notes ILIKE '%Counterparty:%'");
    expect(sqlContent).toContain('Transferred Commitment');
    expect(sqlContent).toContain('Counterparty:');
  });

  it('documents human confirmation and ledger reversal events for cleanup', () => {
    expect(sqlContent).toContain('ledger reversal events');
    expect(sqlContent).toContain('human');
  });
});
