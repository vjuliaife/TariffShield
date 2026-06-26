import { TariffShieldClient } from "../packages/sdk/src/index.js";
import { Keypair } from "@stellar/stellar-sdk";
import deployments from "../deployments.json" with { type: "json" };
import { Pool } from "pg";
import fs from "fs";
import path from "path";

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

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

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

async function validateAccount(account: {
  bondId: bigint;
  collateralBalance: bigint;
  requiredCollateral: bigint;
  reserveBalance: bigint;
  yieldAccrued: bigint;
  isClawbacked: boolean;
  collateralLastUpdated: bigint;
}): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (account.collateralBalance < 0n) {
    errors.push("collateralBalance is negative");
  }
  if (account.requiredCollateral < 0n) {
    errors.push("requiredCollateral is negative");
  }
  if (account.reserveBalance < 0n) {
    errors.push("reserveBalance is negative");
  }
  if (account.yieldAccrued < 0n) {
    errors.push("yieldAccrued is negative");
  }
  if (!account.bondId || account.bondId === 0n) {
    errors.push("bondId is missing or zero");
  }
  if (typeof account.isClawbacked !== "boolean") {
    errors.push("isClawbacked is not a boolean");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function accountToMap(account: {
  bondId: bigint;
  collateralBalance: bigint;
  requiredCollateral: bigint;
  reserveBalance: bigint;
  yieldAccrued: bigint;
  isClawbacked: boolean;
  collateralLastUpdated: bigint;
}): Record<string, string> {
  return {
    bond_id: account.bondId.toString(),
    collateral_balance: account.collateralBalance.toString(),
    required_collateral: account.requiredCollateral.toString(),
    reserve_balance: account.reserveBalance.toString(),
    yield_accrued: account.yieldAccrued.toString(),
    is_clawbacked: account.isClawbacked.toString(),
    collateral_last_updated: account.collateralLastUpdated.toString(),
  };
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log(`[migrate] mode: ${isDryRun ? "dry-run (no transactions)" : "live (will update accounts)"}`);

  const client = new TariffShieldClient({
    rpcUrl: deployments.rpcUrl,
    contractId: deployments.contractId,
    networkPassphrase: deployments.networkPassphrase,
  });

  const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const startTime = Date.now();
  const log: MigrationLog = {
    timestamp: new Date().toISOString(),
    accounts: [],
    summary: { total: 0, successful: 0, failed: 0, duration: 0 },
  };

  try {
    console.log("[migrate] Loading importer addresses from database...");
    const addresses = await loadImporterAddresses(dbPool);
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
        const account = await withRetry(
          () => client.getAccount(address),
          `fetch account ${address}`,
        );

        const validation = await validateAccount(account);
        if (!validation.valid) {
          throw new Error(`Account validation failed: ${validation.errors.join(", ")}`);
        }

        logEntry.oldValues = accountToMap(account);
        logEntry.newValues = accountToMap(account);

        if (isDryRun) {
          console.log(`  [dry-run] Would migrate ${address}`);
          console.log(`    Old: ${JSON.stringify(logEntry.oldValues)}`);
          console.log(`    New: ${JSON.stringify(logEntry.newValues)}`);
          logEntry.status = "success";
          log.summary.successful++;
        } else {
          console.log(`  [live] Migrating ${address}...`);
          const signer = Keypair.fromSecret(process.env.PLATFORM_SECRET!);
          const result = await withRetry(
            () =>
              client.invokeAndSubmit(signer, "migrate_account", [
                new (await import("@stellar/stellar-sdk")).Address(address).toScVal(),
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

    console.log("[migrate] Post-migration verification...");
    let verificationPassed = 0;
    let verificationFailed = 0;

    for (const entry of log.accounts) {
      if (entry.status !== "success") continue;
      try {
        const account = await withRetry(
          () => client.getAccount(entry.address),
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

    log.summary.duration = Date.now() - startTime;
    console.log(
      `\n[migrate] Complete: ${log.summary.successful}/${log.summary.total} migrated, ${log.summary.failed} failed`,
    );
    console.log(`[migrate] Verification: ${verificationPassed} passed, ${verificationFailed} failed`);
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

function nativeToScVal(value: unknown, options?: { type?: string }): any {
  const { nativeToScVal } = require("@stellar/stellar-sdk");
  return nativeToScVal(value, options);
}

main().catch((err) => {
  console.error("[migrate] fatal error:", err);
  process.exit(1);
});
