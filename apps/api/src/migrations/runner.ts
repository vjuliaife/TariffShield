import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface MigrationModule {
  up: (client: PoolClient) => Promise<void>;
  down: (client: PoolClient) => Promise<void>;
  // Set by a migration that runs CREATE/DROP INDEX CONCURRENTLY (or any
  // other statement Postgres refuses to run inside a transaction block —
  // see PreventInTransactionBlock in Postgres's own source). Such a
  // migration is run on its own connection with no surrounding BEGIN/COMMIT,
  // so it does not get the same all-or-nothing rollback guarantee the rest
  // of the chain gets: if it fails partway through, whatever it already
  // created stays behind and must be cleaned up manually before retrying.
  // CONCURRENTLY is designed to leave an INVALID index behind on failure
  // rather than silently rolling back, precisely so it never takes a table
  // lock — so this is Postgres's own tradeoff, not one this runner adds.
  nonTransactional?: boolean;
}

export async function runMigrations(action: 'up' | 'rollback' = 'up'): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 2. Scan and parse migration files
    const files = await fs.readdir(__dirname);
    const migrationPattern = /^(\d{4})_[\w-]+\.(ts|js)$/;

    const migrationFiles = files
      .filter((f) => migrationPattern.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.map'))
      .map((f) => {
        const match = f.match(migrationPattern)!;
        return {
          version: parseInt(match[1]!, 10),
          filename: f,
          name: f.replace(/\.(ts|js)$/, ''),
        };
      })
      .sort((a, b) => a.version - b.version);

    // Validate no duplicate versions
    const seenVersions = new Set<number>();
    for (const m of migrationFiles) {
      if (seenVersions.has(m.version)) {
        throw new Error(`Duplicate migration version detected: ${m.version}`);
      }
      seenVersions.add(m.version);
    }

    if (action === 'up') {
      // Get highest applied migration version
      const res = await client.query('SELECT MAX(version) as max_version FROM schema_migrations');
      const highestApplied = res.rows[0]?.max_version ?? 0;

      const pending = migrationFiles.filter((m) => m.version > highestApplied);
      if (pending.length === 0) {
        console.log('No pending migrations to run.');
        return;
      }

      console.log(`Running ${pending.length} pending migrations...`);
      for (const m of pending) {
        const filePath = path.join(__dirname, m.filename);
        const fileUrl = pathToFileURL(filePath).href;
        const mod = (await import(fileUrl)) as MigrationModule;
        if (typeof mod.up !== 'function') {
          throw new Error(`Migration ${m.filename} does not export an up function.`);
        }

        if (mod.nonTransactional) {
          // CREATE/DROP INDEX CONCURRENTLY (and similarly-restricted
          // statements) are rejected by Postgres inside any transaction
          // block, including one opened by a previous iteration of this
          // same loop — so this migration gets its own connection and runs
          // with no surrounding BEGIN/COMMIT at all.
          const soloClient = await pool.connect();
          try {
            await mod.up(soloClient);
            await soloClient.query(
              'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
              [m.version, m.name]
            );
          } finally {
            soloClient.release();
          }
          console.log(`Successfully applied migration (non-transactional): ${m.name}`);
          continue;
        }

        await client.query('BEGIN');
        try {
          await mod.up(client);
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
            m.version,
            m.name,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`Migration ${m.name} failed, rolled back.`);
          throw err;
        }
        console.log(`Successfully applied migration: ${m.name}`);
      }
    } else if (action === 'rollback') {
      // Find the highest applied migration
      const res = await client.query(
        'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
      );
      if (res.rows.length === 0) {
        console.log('No migrations to rollback.');
        return;
      }

      const { version, name } = res.rows[0];
      const m = migrationFiles.find((mf) => mf.version === version);
      if (!m) {
        throw new Error(
          `Migration file for version ${version} (${name}) not found in migrations directory.`
        );
      }

      console.log(`Rolling back migration: ${m.name}...`);
      const filePath = path.join(__dirname, m.filename);
      const fileUrl = pathToFileURL(filePath).href;
      const mod = (await import(fileUrl)) as MigrationModule;
      if (typeof mod.down !== 'function') {
        throw new Error(`Migration ${m.filename} does not export a down function.`);
      }

      if (mod.nonTransactional) {
        const soloClient = await pool.connect();
        try {
          await mod.down(soloClient);
          await soloClient.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        } finally {
          soloClient.release();
        }
        console.log(`Successfully rolled back migration (non-transactional): ${m.name}`);
      } else {
        await client.query('BEGIN');
        try {
          await mod.down(client);
          await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
          await client.query('COMMIT');
          console.log(`Successfully rolled back migration: ${m.name}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('Rollback transaction failed, rolled back changes.');
          throw err;
        }
      }
    }
  } finally {
    client.release();
  }
}
