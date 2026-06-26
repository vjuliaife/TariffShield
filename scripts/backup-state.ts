#!/usr/bin/env tsx
/**
 * scripts/backup-state.ts
 *
 * Pre-upgrade contract state backup script that exports all Account structs
 * from the TariffShield contract to a timestamped JSON file.
 *
 * Usage:
 *   tsx scripts/backup-state.ts
 *   tsx scripts/backup-state.ts --output-dir /mnt/s3-backup
 */

import { TariffShieldClient } from "../packages/sdk/src/index.js";
import { pool } from "../apps/api/src/db.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface BackupAccount {
  stellarAddress: string;
  bondId: string;
  collateralBalance: string;
  requiredCollateral: string;
  reserveBalance: string;
  yieldAccrued: string;
  isClawbacked: boolean;
}

interface BackupData {
  contractId: string;
  networkPassphrase: string;
  ledgerSequence: number;
  timestamp: string;
  totalAccounts: number;
  totalValueLocked: string;
  accounts: BackupAccount[];
}

async function main() {
  const args = process.argv.slice(2);
  const outputDirIndex = args.indexOf("--output-dir");
  const outputDir =
    outputDirIndex >= 0 && args[outputDirIndex + 1]
      ? args[outputDirIndex + 1]
      : "./backups";

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const contractId = process.env.TARIFF_SHIELD_CONTRACT_ID;
  const rpcUrl = process.env.STELLAR_RPC_URL;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;

  if (!contractId || !rpcUrl || !networkPassphrase) {
    console.error("ERROR: Missing required environment variables");
    console.error(
      "Required: TARIFF_SHIELD_CONTRACT_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE",
    );
    process.exit(1);
  }

  const client = new TariffShieldClient({
    rpcUrl,
    contractId,
    networkPassphrase,
  });

  console.log(`[backup] Querying all registered importers from PostgreSQL...`);
  const result = await pool.query(
    "SELECT stellar_address, bond_id FROM importers ORDER BY created_at",
  );

  const totalImportersInDb = result.rowCount || 0;
  console.log(`[backup] Found ${totalImportersInDb} importers in database`);

  if (totalImportersInDb === 0) {
    console.warn("[backup] No importers found. Backup will be empty.");
  }

  const accounts: BackupAccount[] = [];
  let totalValueLocked = BigInt(0);
  let failedCount = 0;

  for (const row of result.rows) {
    const stellarAddress = row.stellar_address;
    const bondId = row.bond_id;

    try {
      const account = await client.getAccount(stellarAddress);
      accounts.push({
        stellarAddress,
        bondId: bondId.toString(),
        collateralBalance: account.collateralBalance.toString(),
        requiredCollateral: account.requiredCollateral.toString(),
        reserveBalance: account.reserveBalance.toString(),
        yieldAccrued: account.yieldAccrued.toString(),
        isClawbacked: account.isClawbacked,
      });

      totalValueLocked += account.collateralBalance + account.reserveBalance;
    } catch (error: any) {
      console.error(
        `[backup] Failed to fetch account ${stellarAddress}:`,
        error.message,
      );
      failedCount++;
    }
  }

  if (failedCount > 0) {
    console.error(
      `[backup] ERROR: Failed to fetch ${failedCount} out of ${totalImportersInDb} accounts`,
    );
    process.exit(1);
  }

  if (accounts.length !== totalImportersInDb) {
    console.error(
      `[backup] ERROR: Account count mismatch. Expected ${totalImportersInDb}, got ${accounts.length}`,
    );
    process.exit(1);
  }

  // Get current ledger sequence from RPC
  const ledgerSequence = await getCurrentLedgerSequence(rpcUrl);

  const backupData: BackupData = {
    contractId,
    networkPassphrase,
    ledgerSequence,
    timestamp: new Date().toISOString(),
    totalAccounts: accounts.length,
    totalValueLocked: totalValueLocked.toString(),
    accounts,
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `state-backup-${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));
  console.log(`[backup] Backup written to: ${filepath}`);

  // Compute SHA-256 checksum
  const checksumFilename = `state-backup-${timestamp}.sha256`;
  const checksumFilepath = path.join(outputDir, checksumFilename);
  const fileContent = fs.readFileSync(filepath);
  const checksum = crypto
    .createHash("sha256")
    .update(fileContent)
    .digest("hex");
  fs.writeFileSync(checksumFilepath, `${checksum}  ${filename}\n`);
  console.log(`[backup] Checksum written to: ${checksumFilepath}`);

  console.log("\n=== Backup Summary ===");
  console.log(`Contract ID: ${contractId}`);
  console.log(`Network: ${networkPassphrase}`);
  console.log(`Ledger Sequence: ${ledgerSequence}`);
  console.log(`Total Accounts Backed Up: ${accounts.length}`);
  console.log(`Total Value Locked (stroops): ${totalValueLocked.toString()}`);
  console.log(
    `Total Value Locked (XLM): ${(Number(totalValueLocked) / 1e7).toFixed(7)}`,
  );
  console.log(`Backup File: ${filepath}`);
  console.log(`Checksum: ${checksum}`);

  await pool.end();
}

async function getCurrentLedgerSequence(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
      params: [],
    }),
  });

  const data = await response.json();
  return data.result?.sequence ?? 0;
}

main().catch((error) => {
  console.error("[backup] Fatal error:", error);
  process.exit(1);
});
