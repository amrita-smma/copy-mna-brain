-- Migration: widen the deal_type enum beyond majority/minority.
-- Purpose: companies.deal_type only described the two principal-side positions
-- the firm takes. The desk also books public-market positions, capital-markets
-- financings (bond issuance, IPO, follow-on, private placement, debt) and pure
-- advisory mandates (M&A advisory, restructuring, joint venture), and raises
-- funds by equity crowdfunding — the same
-- transaction routes the investment_banking Copilot flavor already compares.
-- Those rows had nowhere to sit, so they were mislabelled as "majority".
--
-- Additive only: ADD VALUE IF NOT EXISTS leaves existing rows and the
-- 'majority' column default untouched. The new values are NOT referenced later
-- in this file — Postgres forbids using an enum value in the same transaction
-- that added it, which is why there is no backfill here.

ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'public_market';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'bond_issuance';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'ipo';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'follow_on_offering';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'private_placement';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'equity_crowdfunding';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'debt_financing';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'ma_advisory';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'restructuring';
ALTER TYPE deal_type ADD VALUE IF NOT EXISTS 'joint_venture';
