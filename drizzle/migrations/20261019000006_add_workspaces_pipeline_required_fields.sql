-- Which fields a company must have before it can enter the pipeline,
-- configurable per workspace in Pipeline Settings → Required Fields. Holds the
-- `PipelineFieldKey`s (see src/lib/pipeline/requiredFields.ts). NULL means
-- "the product default" — every field — so existing workspaces keep today's
-- rules untouched.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS pipeline_required_fields text[];

