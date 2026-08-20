-- MB-493: Backfill retained divestment proceeds to fund-specific cash ledger
-- Creates fund-specific default cash accounts and inserts internal_transfer
-- cash movements for existing cash_in_fund divestments.

DO $$
DECLARE
  r RECORD;
  cash_asset_id UUID;
  fund_name TEXT;
  default_cash_name TEXT;
  curr TEXT;
  calc_amount NUMERIC;
BEGIN
  FOR r IN
    SELECT t.*, a.workspace_id
    FROM fund_asset_transactions t
    JOIN fund_assets a ON a.id = t.fund_asset_id
    WHERE t.txn_type = 'divestment'
      AND t.sell_proceeds_destination = 'cash_in_fund'
      AND t.fund_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM fund_asset_transactions m
        WHERE m.source_divestment_txn_id = t.id
      )
  LOOP
    curr := COALESCE(r.txn_currency, 'USD');
    calc_amount := COALESCE(r.value_amount, (COALESCE(r.price_per_share, 0) * COALESCE(r.share_count, 0)));

    -- 1. Find existing cash asset already attributed to this specific fund and currency
    SELECT a.id INTO cash_asset_id
    FROM fund_assets a
    JOIN fund_asset_transactions atxn ON atxn.fund_asset_id = a.id
    WHERE a.workspace_id = r.workspace_id
      AND a.asset_type = 'cash'
      AND atxn.fund_id = r.fund_id
      AND UPPER(COALESCE(a.investment_currency, a.report_currency, 'USD')) = UPPER(curr)
    LIMIT 1;

    -- 2. If no cash asset exists for this fund, create a fund-specific cash asset
    IF cash_asset_id IS NULL THEN
      SELECT f.name INTO fund_name
      FROM funds f
      WHERE f.id = r.fund_id;

      default_cash_name := 'Cash - ' || COALESCE(fund_name, r.fund_id::text) || ' (' || curr || ')';

      INSERT INTO fund_assets (
        workspace_id,
        asset_type,
        asset_name,
        investment_currency,
        report_currency,
        status,
        type_details
      ) VALUES (
        r.workspace_id,
        'cash',
        default_cash_name,
        curr,
        curr,
        'active',
        '{}'::jsonb
      ) RETURNING id INTO cash_asset_id;
    END IF;

    -- 3. Insert linked internal_transfer cash movement
    INSERT INTO fund_asset_transactions (
      fund_asset_id,
      fund_id,
      holding_entity_id,
      funding_source_id,
      txn_date,
      txn_type,
      sub_type_label,
      value_amount,
      txn_currency,
      fx_rate,
      sell_proceeds_destination,
      source_divestment_txn_id,
      notes
    ) VALUES (
      cash_asset_id,
      r.fund_id,
      r.holding_entity_id,
      r.funding_source_id,
      r.txn_date,
      'internal_transfer',
      'Retained sale proceeds',
      calc_amount,
      curr,
      COALESCE(r.fx_rate, 1),
      NULL,
      r.id,
      COALESCE('Retained proceeds from divestment: ' || r.notes, 'Retained proceeds from divestment')
    ) ON CONFLICT (source_divestment_txn_id) DO NOTHING;

  END LOOP;
END $$;
