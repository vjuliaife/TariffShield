// 0005_scalability_indexes.ts
// Adds indexes recommended by the scalability investigation.
//
// Migration: 0005_scalability_indexes
// Date: 2026-08-26
// Issue: Scalability investigation — pagination and polling performance

import type { PoolClient } from 'pg';

// CREATE INDEX CONCURRENTLY is rejected by Postgres inside any transaction
// block — see runner.ts's MigrationModule.nonTransactional doc comment.
export const nonTransactional = true;

export const up = async (client: PoolClient): Promise<void> => {
  // 1. Composite index for surety license listing pagination
  // Supports: ORDER BY created_at DESC, id DESC with cursor-based pagination
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_surety_license_verifications_created_at_id
    ON surety_license_verifications (created_at DESC, id DESC)
  `);

  // 2. Composite index for bond signature polling
  // Supports: WHERE bond_record_id = $1 ORDER BY created_at DESC LIMIT 1
  await client.query(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bond_signatures_bond_created
    ON bond_signatures (bond_record_id, created_at DESC)
  `);

  // 3. Covering index for webhook envelope lookup
  // Supports: WHERE envelope_id = $1 (already UNIQUE, but this avoids heap fetch for status check)
  // Note: envelope_id already has a UNIQUE index, so this is redundant.
  // Included only if we need to check status before update (idempotency guard).
  // Skip if envelope_id UNIQUE index already covers this.
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_surety_license_verifications_created_at_id`);
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS idx_bond_signatures_bond_created`);
};
