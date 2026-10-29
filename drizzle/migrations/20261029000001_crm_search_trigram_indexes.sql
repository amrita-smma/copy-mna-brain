-- crm_search_trigram_indexes
-- Indexes behind the server-side CRM search (`/api/crm?q=` and the per-firm
-- contacts search). Both match by substring (`ILIKE '%term%'`), which a btree
-- cannot serve, so every debounced keystroke sequentially scanned employers,
-- employer_curation, employer_domains, correspondents and
-- correspondent_curation. A trigram GIN index answers `ILIKE '%term%'`
-- directly; EmployerRepository.searchMatchIds is written as one indexable
-- branch per column so the planner can use them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_employers_name_trgm
  ON employers USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_employer_curation_name_trgm
  ON employer_curation USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_employer_domains_domain_trgm
  ON employer_domains USING gin (domain gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_correspondents_name_trgm
  ON correspondents USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_correspondents_email_trgm
  ON correspondents USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_correspondent_curation_name_trgm
  ON correspondent_curation USING gin (name gin_trgm_ops);
