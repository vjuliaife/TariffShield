-- Migration 007: Missing indexes on hot-path queries in routes/importers.ts (issue #257)
-- Up
--
-- Analysis identified index gaps causing sequential scans on the most
-- frequently hit query paths at production data volumes:
--
--   Query                              Missing index
--   ─────────────────────────────────  ──────────────────────────────────────────
--   importers WHERE user_id = $1       importers.user_id
--   importers ORDER BY created_at DESC importers.created_at DESC
--   bonds WHERE importer_id ORDER BY   bonds(importer_id, created_at DESC)
--     created_at DESC
--   tariff_uploads WHERE importer_id   tariff_uploads(importer_id, created_at DESC)
--     ORDER BY created_at DESC LIMIT 1
--
-- All indexes use CONCURRENTLY to avoid table-level locks in production.
-- See docs/query-analysis.md for full EXPLAIN ANALYZE output and cost table.
--
-- #1095 correction: this file originally also declared
--   CREATE INDEX CONCURRENTLY idx_contract_events_importer_created_at
--     ON contract_events(importer_id, created_at DESC, id DESC);
-- contract_events has been a partitioned table (PARTITION BY RANGE
-- (created_at)) since migration 0002_partition_contract_events.ts, and
-- PostgreSQL does not support CREATE INDEX CONCURRENTLY directly on a
-- partitioned table — every run of this file failed on that one statement.
-- Because `psql -f` does not abort on a single statement error, this went
-- unnoticed: the other four indexes below were created successfully and
-- the failure was silent unless someone was watching the output.
--
-- The intended target query, GET /:id/events (cursor pagination in
-- routes/importers.ts), orders by `id DESC` alone — it never sorts by
-- created_at. That's already fully covered by
-- idx_contract_events_importer_id_pagination(importer_id, id DESC), which
-- 0002 declared on the contract_events parent (so it auto-propagates to
-- every partition, current and future). The two remaining contract_events
-- queries that do filter by created_at (routes/importers.ts GET
-- /admin/events, routes/regulatory.ts's claims-filed query) have no
-- importer_id predicate, so they're served by the BRIN index
-- idx_contract_events_created_at_brin, also from 0002.
-- So the statement is dropped outright rather than reworked into a
-- per-partition CONCURRENTLY + ATTACH PARTITION sequence — there is no
-- query in this codebase it would actually serve.

-- importers.user_id: supports both the "does this user already have an importer?"
-- existence check (POST /) and the per-user importer list (GET / non-admin path).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_importers_user_id
  ON importers(user_id);

-- importers.created_at DESC: supports the surety-admin list (GET /) which orders
-- all importers by creation time descending without a WHERE filter.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_importers_created_at
  ON importers(created_at DESC);

-- bonds(importer_id, created_at DESC): supports GET /:id/bonds which fetches the
-- full bond history for an importer ordered by created_at DESC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_importer_created_at
  ON bonds(importer_id, created_at DESC);

-- tariff_uploads(importer_id, created_at DESC): supports POST /:id/verify-oracle-data
-- which fetches the latest tariff upload for an importer, with and without an
-- as_of_date filter, using ORDER BY created_at DESC LIMIT 1.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tariff_uploads_importer_created_at
  ON tariff_uploads(importer_id, created_at DESC);
