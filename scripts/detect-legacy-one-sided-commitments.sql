-- ==============================================================================
-- DETECT LEGACY ONE-SIDED IMPORTED COMMITMENT ROWS
-- ==============================================================================
-- 
-- PURPOSE:
--   Identifies legacy imported commitment rows in the fund ledger that were recorded
--   with one-sided commitment transfer notes ('Transferred Commitment' or 'Counterparty:').
-- 
-- SAFETY NOTICE:
--   * READ-ONLY: This script is purely diagnostic and performs no write operations.
--   * DO NOT DELETE OR MUTATE: Do not execute UPDATE, DELETE, or TRUNCATE commands
--     against fl_ledger_entries, fl_business_events, or fl_positions.
--   * CLEANUP PROTOCOL: Any remediation or cleanup of invalid/erroneous rows MUST
--     be executed via proper ledger reversal events (e.g. via FlLedgerService.reverseEvent
--     or POST /api/fund-ledger/events/:id/reverse) AFTER human review and confirmation.
-- ==============================================================================

SELECT
  -- 1. Workspace
  p.workspace_id,

  -- 2. Business Event
  be.id AS business_event_id,
  be.event_date AS business_event_date,
  be.description AS business_event_description,
  be.status AS business_event_status,

  -- 3. Entry & Position
  le.id AS ledger_entry_id,
  le.position_id,
  p.status AS position_status,
  p.holder_investor_id,
  p.holder_fund_id,
  p.fund_id AS target_fund_id,
  p.asset_id AS target_asset_id,

  -- 4. Event Date
  le.entry_date,

  -- 5. Commitment Delta & Currency
  le.commitment_delta,
  le.currency,

  -- 6. Notes
  le.notes AS entry_notes,

  -- 7. Source Record (provenance)
  COALESCE(le.source_record_id, be.source_record_id) AS source_record_id,
  sr.file_id AS source_file_id,
  sr.sheet_name AS source_sheet_name,
  sr.row_number AS source_row_number,

  -- 8. Reversal Status
  le.is_reversal AS entry_is_reversal,
  be.status AS event_reversal_status,
  be.reversal_of_event_id

FROM fl_ledger_entries le
INNER JOIN fl_positions p
  ON le.position_id = p.id
LEFT JOIN fl_business_events be
  ON le.business_event_id = be.id
LEFT JOIN fl_source_records sr
  ON COALESCE(le.source_record_id, be.source_record_id) = sr.id

WHERE
  le.entry_type = 'commitment'
  AND (
    le.notes ILIKE '%Transferred Commitment%'
    OR le.notes ILIKE '%Counterparty:%'
  )

ORDER BY
  p.workspace_id ASC,
  le.entry_date ASC,
  le.id ASC;
