-- add-precalculated-metrics

ALTER TABLE "fund_assets"
ADD COLUMN "fmv_amount" numeric;

ALTER TABLE "investors"
ADD COLUMN "invested_amount" numeric,
ADD COLUMN "realized_amount" numeric,
ADD COLUMN "fmv_amount" numeric,
ADD COLUMN "dpi" numeric,
ADD COLUMN "moic" numeric,
ADD COLUMN "irr" numeric,
ADD COLUMN "metrics_computed_at" timestamp with time zone;

ALTER TABLE "funding_sources"
ADD COLUMN "invested_amount" numeric,
ADD COLUMN "realized_amount" numeric,
ADD COLUMN "fmv_amount" numeric,
ADD COLUMN "dpi" numeric,
ADD COLUMN "moic" numeric,
ADD COLUMN "irr" numeric,
ADD COLUMN "metrics_computed_at" timestamp with time zone;
