#!/usr/bin/env tsx
/**
 * scripts/verify-upgrade.ts
 *
 * Post-upgrade verification suite that confirms all importer accounts are readable,
 * storage is intact, and all entrypoints function correctly after a contract upgrade.
 *
 * Usage:
 *   tsx scripts/verify-upgrade.ts
 *   tsx scripts/verify-upgrade.ts --skip-canary
 */

import { TariffShieldClient, Keypair } from "../packages/sdk/src/index.js";
import { pool } from "../apps/api/src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface VerificationReport {
  contractId: string;
  wasmHash: string;
  ledgerSequence: number;
  timestamp: string;
  totalAccountsVerified: number;
  accountResults: AccountVerificationResult[];
  canaryResult: CanaryResult | null;
  overallStatus: "PASS" | "FAIL";
}

interface AccountVerificationResult {
  stellarAddress: string;
  bondId: string;
  status: "PASS" | "FAIL";
  error?: string;
  fieldsChanged?: string[];
}

interface CanaryResult {
  status: "PASS" | "FAIL";
  depositTxHash?: string;
  withdrawTxHash?: string;
  error?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const skipCanary = args.includes("--skip-canary");

  const contractId = process.env.TARIFF_SHIELD_CONTRACT_ID;
  const rpcUrl = process.env.STELLAR_RPC_URL;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  const canaryImporterAddress = process.env.CANARY_IMPORTER_ADDRESS;
  const canaryImporterSecret = process.env.CANARY_IMPORTER_SECRET;

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

  console.log("[verify-upgrade] Starting post-upgrade verification...\n");

  // Load pre-upgrade backup for comparison
  const backupDir = "./backups";
  let backupData: any = null;
  if (fs.existsSync(backupDir)) {
    const backupFiles = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("state-backup-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (backupFiles.length > 0) {
      const latestBackup = path.join(backupDir, backupFiles[0]);
      backupData = JSON.parse(fs.readFileSync(latestBackup, "utf-8"));
      console.log(`[verify-upgrade] Using backup: ${backupFiles[0]}\n`);
    } else {
      console.warn("[verify-upgrade] WARNING: No backup found in ./backups/\n");
    }
  }

  // Verify view entrypoints are functional
  console.log("[verify-upgrade] Testing view entrypoints...");
  try {
    const admin = await client.getAdmin();
    console.log(`  ✓ get_admin: ${admin}`);

    const surety = await client.getSurety();
    console.log(`  ✓ get_surety: ${surety}`);

    const token = await client.getToken();
    console.log(`  ✓ get_token: ${token}`);
  } catch (error: any) {
    console.error(`  ✗ View entrypoint failure: ${error.message}`);
    console.error(
      "\n[verify-upgrade] FAILURE: Basic view entrypoints are broken",
    );
    process.exit(1);
  }

  // Query all importer addresses
  console.log("\n[verify-upgrade] Querying all importers from database...");
  const result = await pool.query(
    "SELECT stellar_address, bond_id FROM importers ORDER BY created_at",
  );

  const totalImporters = result.rowCount || 0;
  console.log(`[verify-upgrade] Found ${totalImporters} importers\n`);

  const accountResults: AccountVerificationResult[] = [];
  let failedAccounts = 0;

  for (const row of result.rows) {
    const stellarAddress = row.stellar_address;
    const bondId = row.bond_id.toString();

    try {
      const account = await client.getAccount(stellarAddress);

      // Compare with backup if available
      let fieldsChanged: string[] = [];
      if (backupData) {
        const backupAccount = backupData.accounts.find(
          (a: any) => a.stellarAddress === stellarAddress,
        );

        if (backupAccount) {
          if (account.bondId.toString() !== backupAccount.bondId) {
            fieldsChanged.push("bondId");
          }
          if (
            account.collateralBalance.toString() !==
            backupAccount.collateralBalance
          ) {
            fieldsChanged.push("collateralBalance");
          }
          if (
            account.requiredCollateral.toString() !==
            backupAccount.requiredCollateral
          ) {
            fieldsChanged.push("requiredCollateral");
          }
          if (
            account.reserveBalance.toString() !== backupAccount.reserveBalance
          ) {
            fieldsChanged.push("reserveBalance");
          }
          if (account.yieldAccrued.toString() !== backupAccount.yieldAccrued) {
            fieldsChanged.push("yieldAccrued");
          }
          if (account.isClawbacked !== backupAccount.isClawbacked) {
            fieldsChanged.push("isClawbacked");
          }
        }
      }

      if (fieldsChanged.length > 0) {
        accountResults.push({
          stellarAddress,
          bondId,
          status: "FAIL",
          fieldsChanged,
          error: `Unexpected field changes: ${fieldsChanged.join(", ")}`,
        });
        failedAccounts++;
        console.log(`  ✗ ${stellarAddress}: Field changes detected`);
      } else {
        accountResults.push({
          stellarAddress,
          bondId,
          status: "PASS",
        });
        console.log(`  ✓ ${stellarAddress}`);
      }
    } catch (error: any) {
      accountResults.push({
        stellarAddress,
        bondId,
        status: "FAIL",
        error: error.message,
      });
      failedAccounts++;
      console.log(`  ✗ ${stellarAddress}: ${error.message}`);
    }
  }

  // Canary deposit/withdrawal cycle
  let canaryResult: CanaryResult | null = null;
  if (!skipCanary) {
    console.log(
      "\n[verify-upgrade] Running canary deposit/withdrawal cycle...",
    );

    if (!canaryImporterAddress || !canaryImporterSecret) {
      console.error(
        "  ✗ ERROR: CANARY_IMPORTER_ADDRESS and CANARY_IMPORTER_SECRET required",
      );
      canaryResult = {
        status: "FAIL",
        error: "Missing canary credentials",
      };
      failedAccounts++;
    } else {
      try {
        const canaryKeypair = Keypair.fromSecret(canaryImporterSecret);
        const testAmount = BigInt(1_000_000); // 0.1 XLM

        const beforeAccount = await client.getAccount(canaryImporterAddress);
        const beforeBalance = beforeAccount.collateralBalance;

        console.log(`  Initial balance: ${beforeBalance.toString()}`);
        console.log(`  Depositing ${testAmount.toString()} stroops...`);

        const depositResult = await client.depositCollateral(
          canaryKeypair,
          canaryImporterAddress,
          canaryImporterAddress,
          testAmount,
        );
        console.log(`  ✓ Deposit tx: ${depositResult.txHash}`);

        const afterDepositAccount = await client.getAccount(
          canaryImporterAddress,
        );
        const afterDepositBalance = afterDepositAccount.collateralBalance;

        if (afterDepositBalance !== beforeBalance + testAmount) {
          throw new Error(
            `Balance mismatch after deposit. Expected ${beforeBalance + testAmount}, got ${afterDepositBalance}`,
          );
        }

        console.log(`  Withdrawing ${testAmount.toString()} stroops...`);
        const withdrawResult = await client.withdrawCollateral(
          canaryKeypair,
          canaryImporterAddress,
          canaryImporterAddress,
          testAmount,
        );
        console.log(`  ✓ Withdraw tx: ${withdrawResult.txHash}`);

        const afterWithdrawAccount = await client.getAccount(
          canaryImporterAddress,
        );
        const afterWithdrawBalance = afterWithdrawAccount.collateralBalance;

        if (afterWithdrawBalance !== beforeBalance) {
          throw new Error(
            `Balance mismatch after withdrawal. Expected ${beforeBalance}, got ${afterWithdrawBalance}`,
          );
        }

        canaryResult = {
          status: "PASS",
          depositTxHash: depositResult.txHash,
          withdrawTxHash: withdrawResult.txHash,
        };
        console.log(`  ✓ Canary cycle completed successfully`);
      } catch (error: any) {
        canaryResult = {
          status: "FAIL",
          error: error.message,
        };
        failedAccounts++;
        console.log(`  ✗ Canary cycle failed: ${error.message}`);
      }
    }
  } else {
    console.log(
      "\n[verify-upgrade] Skipping canary cycle (--skip-canary flag)\n",
    );
  }

  // Get current ledger and wasm hash
  const ledgerSequence = await getCurrentLedgerSequence(rpcUrl);
  const wasmHash = await getContractWasmHash(rpcUrl, contractId);

  // Generate report
  const report: VerificationReport = {
    contractId,
    wasmHash,
    ledgerSequence,
    timestamp: new Date().toISOString(),
    totalAccountsVerified: totalImporters,
    accountResults,
    canaryResult,
    overallStatus: failedAccounts === 0 ? "PASS" : "FAIL",
  };

  // Write report
  const reportDir = "./verification-reports";
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `verify-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[verify-upgrade] Report written to: ${reportPath}`);

  // Print summary
  console.log("\n=== Verification Summary ===");
  console.log(`Contract ID: ${contractId}`);
  console.log(`WASM Hash: ${wasmHash}`);
  console.log(`Ledger Sequence: ${ledgerSequence}`);
  console.log(`Total Accounts Verified: ${totalImporters}`);
  console.log(`Passed: ${totalImporters - failedAccounts}`);
  console.log(`Failed: ${failedAccounts}`);
  console.log(`Canary Status: ${canaryResult?.status || "SKIPPED"}`);
  console.log(`Overall Status: ${report.overallStatus}`);

  await pool.end();

  if (report.overallStatus === "FAIL") {
    process.exit(1);
  }
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

async function getContractWasmHash(
  rpcUrl: string,
  contractId: string,
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getContractData",
      params: [contractId],
    }),
  });

  const data = await response.json();
  return data.result?.wasmHash ?? "unknown";
}

main().catch((error) => {
  console.error("[verify-upgrade] Fatal error:", error);
  process.exit(1);
});
