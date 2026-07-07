-- MB-337 follow-up: remove the "favorite/star a company" feature.
-- Raised in PR #308 review — user_company_favorites is a live feature but
-- unrelated to workspace tenancy; product decision was to drop it outright
-- (backend, frontend, and the underlying table) rather than carry it forward.
-- This deletes every user's existing favorites.

DROP TABLE IF EXISTS user_company_favorites;
