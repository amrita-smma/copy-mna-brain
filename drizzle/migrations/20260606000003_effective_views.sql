CREATE OR REPLACE VIEW employer_effective
  WITH (security_invoker = on) AS
SELECT
  e.id,
  COALESCE(c.name,     e.name)     AS name,
  COALESCE(c.industry, e.industry) AS industry,
  e.normalized_name,               -- always the MACHINE name (merge key); never overridden
  e.status,
  e.curation_status,
  e.created_at,
  e.updated_at
FROM employers e
LEFT JOIN employer_curation c ON c.employer_id = e.id;

CREATE OR REPLACE VIEW correspondent_effective
  WITH (security_invoker = on) AS
SELECT
  co.id,
  co.employer_id,
  COALESCE(cc.name,  co.name)  AS name,
  COALESCE(cc.title, co.title) AS title,
  co.email,                        -- natural key; machine-owned
  COALESCE(cc.phone, co.phone) AS phone,
  COALESCE(cc.type,  co.type)  AS type,
  co.is_primary,                   -- base-only (one-primary unique index enforces)
  co.source,
  co.origin,
  co.last_edited_by_user_id,
  co.last_edited_at,
  co.created_at,
  co.updated_at
FROM correspondents co
LEFT JOIN correspondent_curation cc ON cc.correspondent_id = co.id;
