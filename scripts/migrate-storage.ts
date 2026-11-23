/**
 * scripts/migrate-storage.ts
 *
 * Re-persists every importer's on-chain Account state after the v0_1_0 -> v0_2_0
 * contract upgrade by invoking the contract's `migrate_account` entrypoint
 * (see docs/mainnet-migration.md).
 *
 * Usage:
 *   npx tsx scripts/migrate-storage.ts --dry-run              # plan against the configured contract (read-only)
 *   npx tsx scripts/migrate-storage.ts --dry-run --offline    # plan against local seed data (no RPC / deployments.json)
 *   npx tsx scripts/migrate-storage.ts --help
 *   npx tsx scripts/migrate-storage.ts                        # live migration (submits transactions)
 *
 * Flags:
 *   --dry-run  Log the planned per-account oldValues/newValues diff without
 *              signing or submitting any transaction. A MigrationLog JSON file
 *              is still written to migration-logs/.
 *   --offline  Only valid together with --dry-run: derive each account's state
 *              from the local docker-compose Postgres (`docker compose up -d
 *              postgres && npm run seed`) instead of fetching it from Soroban
 *              RPC. No deployments.json or deployed contract required.
 *   --help     Print this usage.
 *
 * Environment:
 *   DATABASE_URL     Postgres connection string (defaults to the local
 *                    docker-compose database).
 *   PLATFORM_SECRET  Signs migrate_account transactions; live runs only.
 */

import { TariffShieldClient } from "../packages/sdk/src/index.js";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import {
  accountFromImporterRow,
  accountToMap,
  planAccountMigration,
  validateAccount,
  type MigratableAccount,
} from "./lib/migrate-storage-logic.js";

interface MigrationLog {
  timestamp: string;
  accounts: {
    address: string;
    oldValues: Record<string, string>;
    newValues: Record<string, string>;
    txHash?: string;
    status: "success" | "failed";
    error?: string;
  }[];
  summary: {
    total: number;
    successful: number;
    failed: number;
    duration: number;
  };
}

interface Deployments {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
}

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const DEFAULT_DATABASE_URL =
  "postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield";

function printUsage(): void {
  console.log("Usage: npx tsx scripts/migrate-storage.ts [--dry-run [--offline]]");
  console.log("");
  console.log(
    "  --dry-run  Log the planned per-account oldValues/newValues diff without submitting transactions."
  );
  console.log(
    "  --offline  With --dry-run: plan against local docker-compose Postgres seed data instead of Soroban RPC."
  );
  console.log("  --help     Print this usage.");
}

/**
 * Loads deployments.json lazily (instead of at import time) so that
 * --dry-run --offline works in checkouts where the gitignored file is absent.
 */
function loadDeployments(): Deployments {
  const deploymentsPath = path.resolve(process.cwd(), "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    console.error(`[migrate] deployments.json not found at ${deploymentsPath}`);
    console.error(
      "[migrate] Deploy the contract first, or run `--dry-run --offline` to plan against local seed data."
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf-8")) as Deployments;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: Error | null = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      const backoff = BASE_BACKOFF_MS * Math.pow(2, i);
      console.warn(`[retry ${i + 1}/${MAX_RETRIES}] ${label}: ${lastError.message}, backoff ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function loadImporterAddresses(pool: Pool): Promise<string[]> {
  const result = await pool.query("SELECT stellar_address FROM importers WHERE stellar_address IS NOT NULL");
  return result.rows.map((row) => row.stellar_address);
}

/**
 * Offline account source for `--dry-run --offline`: builds each demo importer's
 * account from local seed data instead of the chain, so the migration plan can
 * be reviewed without a deployed contract. `required_collateral` comes from the
 * importer's latest tariff upload; on-chain-only fields default to zero.
 */
async function loadOfflineAccounts(pool: Pool): Promise<Map<string, MigratableAccount>> {
  const result = await pool.query(
    `SELECT i.stellar_address,
            i.bond_id,
            i.collateral_balance,
            (SELECT t.computed_required_collateral
               FROM tariff_uploads t
              WHERE t.importer_id = i.id
              ORDER BY t.created_at DESC
              LIMIT 1) AS required_collateral
       FROM importers i
      WHERE i.stellar_address IS NOT NULL
      ORDER BY i.created_at`
  );

  const accounts = new Map<string, MigratableAccount>();
  for (const row of result.rows) {
    accounts.set(row.stellar_address, accountFromImporterRow(row));
  }
  return accounts;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const isDryRun = args.includes("--dry-run");
  const isOffline = args.includes("--offline");

  if (isOffline && !isDryRun) {
    console.error("[migrate] --offline is only supported together with --dry-run");
    printUsage();
    process.exit(1);
  }

  const mode = isDryRun
    ? isOffline
      ? "dry-run (offline: local seed data)"
      : "dry-run (no transactions)"
    : "live (will update accounts)";
  console.log(`[migrate] mode: ${mode}`);

  const client = isOffline ? null : new TariffShieldClient(loadDeployments());

  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  });

  const startTime = Date.now();
  const log: MigrationLog = {
    timestamp: new Date().toISOString(),
    accounts: [],
    summary: { total: 0, successful: 0, failed: 0, duration: 0 },
  };

  try {
    console.log("[migrate] Loading importer addresses from database...");
    const offlineAccounts = isOffline ? await loadOfflineAccounts(dbPool) : null;
    const addresses = offlineAccounts
      ? [...offlineAccounts.keys()]
      : await loadImporterAddresses(dbPool);
    log.summary.total = addresses.length;
    console.log(`[migrate] Found ${addresses.length} importers to migrate`);

    for (const address of addresses) {
      console.log(`[migrate] Processing ${address}...`);
      const logEntry = {
        address,
        oldValues: {},
        newValues: {},
        txHash: undefined as string | undefined,
        status: "failed" as "success" | "failed",
        error: undefined as string | undefined,
      };

      try {
        const account: MigratableAccount = offlineAccounts
          ? offlineAccounts.get(address)!
          : await withRetry(
              () => client!.getAccount(address),
              `fetch account ${address}`,
            );

        const validation = validateAccount(account);
        if (!validation.valid) {
          throw new Error(`Account validation failed: ${validation.errors.join(", ")}`);
        }

        const plan = planAccountMigration(address, account);
        logEntry.oldValues = plan.oldValues;
        logEntry.newValues = plan.newValues;

        if (isDryRun) {
          console.log(`  [dry-run] Would migrate ${address}`);
          console.log(`    Old: ${JSON.stringify(plan.oldValues)}`);
          console.log(`    New: ${JSON.stringify(plan.newValues)}`);
          console.log(
            plan.changedFields.length > 0
              ? `    Changed fields: ${plan.changedFields.join(", ")}`
              : "    Changed fields: none (account re-persisted unchanged)"
          );
          logEntry.status = "success";
          log.summary.successful++;
        } else {
          console.log(`  [live] Migrating ${address}...`);
          const signer = Keypair.fromSecret(process.env.PLATFORM_SECRET!);
          const result = await withRetry(
            () =>
              client!.invokeAndSubmit(signer, "migrate_account", [
                new Address(address).toScVal(),
                nativeToScVal(account, { type: "object" }),
              ]),
            `migrate account ${address}`,
          );
          logEntry.txHash = result.txHash;
          logEntry.status = "success";
          log.summary.successful++;
          console.log(`  [live] Migrated ${address} in tx ${result.txHash}`);
        }
      } catch (err) {
        logEntry.error = (err as Error).message;
        logEntry.status = "failed";
        log.summary.failed++;
        console.error(`  [error] Failed to migrate ${address}: ${logEntry.error}`);
      }

      log.accounts.push(logEntry);
    }

    let verificationPassed = 0;
    let verificationFailed = 0;

    if (isOffline) {
      console.log(
        "[migrate] Offline dry-run: skipping post-migration verification (no chain state to compare)"
      );
    } else {
      console.log("[migrate] Post-migration verification...");

      for (const entry of log.accounts) {
        if (entry.status !== "success") continue;
        try {
          const account = await withRetry(
            () => client!.getAccount(entry.address),
            `verify account ${entry.address}`,
          );
          const newMap = accountToMap(account);
          const matches = JSON.stringify(entry.newValues) === JSON.stringify(newMap);
          if (matches) {
            console.log(`  [verified] ${entry.address}`);
            verificationPassed++;
          } else {
            console.error(`  [mismatch] ${entry.address}`);
            verificationFailed++;
          }
        } catch (err) {
          console.error(`  [verify-error] ${entry.address}: ${(err as Error).message}`);
          verificationFailed++;
        }
      }

      console.log(`[migrate] Verification: ${verificationPassed} passed, ${verificationFailed} failed`);
    }

    log.summary.duration = Date.now() - startTime;
    console.log(
      `\n[migrate] Complete: ${log.summary.successful}/${log.summary.total} migrated, ${log.summary.failed} failed`,
    );
    console.log(`[migrate] Duration: ${(log.summary.duration / 1000).toFixed(2)}s`);

    const logsDir = path.join(process.cwd(), "migration-logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, `migrate-${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
    console.log(`[migrate] Log written to ${logFile}`);

    if (isDryRun && log.summary.failed === 0) {
      console.log("[migrate] Dry run successful, no issues detected");
      process.exit(0);
    } else if (!isDryRun && log.summary.failed === 0 && verificationFailed === 0) {
      console.log("[migrate] Migration successful, all accounts verified");
      process.exit(0);
    } else {
      console.error("[migrate] Migration incomplete, check logs");
      process.exit(1);
    }
  } finally {
    await dbPool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] fatal error:", err);
  process.exit(1);
});
