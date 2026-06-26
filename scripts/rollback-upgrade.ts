#!/usr/bin/env tsx
/**
 * scripts/rollback-upgrade.ts
 *
 * ROLLBACK CHECKLIST:
 * 1. ✓ Confirm backup exists (scripts/backup-state.ts was run before upgrade)
 * 2. ✓ Run scripts/list-wasm-hashes.ts to identify the previous wasm hash
 * 3. ✓ Run this script with --previous-wasm-hash flag
 * 4. ✓ Run scripts/verify-upgrade.ts to confirm rollback success
 * 5. ✓ Notify on-call channel with rollback status
 *
 * Reverts the TariffShield contract to a previous wasm hash by invoking
 * the upgrade entrypoint with the prior version.
 *
 * Usage:
 *   tsx scripts/rollback-upgrade.ts --previous-wasm-hash <hash> --contract-id <id>
 */

import {
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import * as crypto from "node:crypto";

async function main() {
  const args = process.argv.slice(2);

  const previousWasmHashIndex = args.indexOf("--previous-wasm-hash");
  const contractIdIndex = args.indexOf("--contract-id");

  if (previousWasmHashIndex === -1 || !args[previousWasmHashIndex + 1]) {
    console.error("ERROR: --previous-wasm-hash flag is required");
    console.error(
      "\nRun scripts/list-wasm-hashes.ts to find the correct previous hash",
    );
    console.error("\nUsage:");
    console.error(
      "  tsx scripts/rollback-upgrade.ts --previous-wasm-hash <hash> --contract-id <id>",
    );
    process.exit(1);
  }

  const previousWasmHash = args[previousWasmHashIndex + 1];
  const contractId =
    contractIdIndex >= 0 && args[contractIdIndex + 1]
      ? args[contractIdIndex + 1]
      : process.env.TARIFF_SHIELD_CONTRACT_ID;

  const rpcUrl = process.env.STELLAR_RPC_URL;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  const adminSecret =
    process.env.PLATFORM_STELLAR_SECRET || process.env.ADMIN_1_SECRET;

  if (!contractId || !rpcUrl || !networkPassphrase || !adminSecret) {
    console.error("ERROR: Missing required environment variables");
    console.error(
      "Required: STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE, PLATFORM_STELLAR_SECRET",
    );
    process.exit(1);
  }

  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
  const adminKeypair = Keypair.fromSecret(adminSecret);
  const contract = new Contract(contractId);

  console.log("[rollback] Checking current contract version...");

  // Call version() or get_admin to confirm contract is responsive
  try {
    const sourceAccount = await server.getAccount(adminKeypair.publicKey());
    const versionTx = new TransactionBuilder(sourceAccount, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(contract.call("get_admin"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(versionTx);
    if (rpc.Api.isSimulationError(sim)) {
      console.error(`Current contract is not responding: ${sim.error}`);
    } else {
      console.log("[rollback] Contract is responsive");
    }
  } catch (error: any) {
    console.error(`WARNING: Could not query current version: ${error.message}`);
  }

  console.log(`[rollback] Rolling back to wasm hash: ${previousWasmHash}`);
  console.log(`[rollback] Contract ID: ${contractId}`);
}

  // Build upgrade transaction with previous wasm hash
  const wasmHashBuffer = Buffer.from(previousWasmHash, "hex");
  const wasmHashScVal = xdr.ScVal.scvBytes(wasmHashBuffer);

  const account = await server.getAccount(adminKeypair.publicKey());
  const upgradeTx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM for upgrade operation
    networkPassphrase,
  })
    .addOperation(contract.call("upgrade", wasmHashScVal))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(upgradeTx);
  prepared.sign(adminKeypair);

  console.log("[rollback] Submitting rollback transaction...");
  const sendResponse = await server.sendTransaction(prepared);

  if (sendResponse.status === "ERROR") {
    console.error("[rollback] Transaction submission failed:", sendResponse.errorResult);
    process.exit(1);
  }

  const txHash = sendResponse.hash;
  console.log(`[rollback] Transaction submitted: ${txHash}`);
  console.log("[rollback] Waiting for confirmation...");

  let txResult = await server.getTransaction(txHash);
  const deadline = Date.now() + 90_000; // 90 seconds

  while (txResult.status === "NOT_FOUND" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    txResult = await server.getTransaction(txHash);
  }

  if (txResult.status !== "SUCCESS") {
    console.error(`[rollback] Transaction failed with status: ${txResult.status}`);
    process.exit(1);
  }

  console.log("[rollback] ✓ Rollback transaction successful");
  console.log(`[rollback] Transaction hash: ${txHash}`);

  // Verify the rollback by checking contract is responsive
  console.log("\n[rollback] Verifying rolled-back contract...");
  try {
    const verifyAccount = await server.getAccount(adminKeypair.publicKey());
    const verifyTx = new TransactionBuilder(verifyAccount, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(contract.call("get_admin"))
      .setTimeout(30)
      .build();

    const verifySim = await server.simulateTransaction(verifyTx);
    if (rpc.Api.isSimulationError(verifySim)) {
      console.error(`[rollback] WARNING: Contract may not be functional: ${verifySim.error}`);
      console.error("[rollback] Run scripts/verify-upgrade.ts immediately");
      process.exit(1);
    }

    console.log("[rollback] ✓ Contract is responsive after rollback");
  } catch (error: any) {
    console.error(`[rollback] WARNING: Could not verify rollback: ${error.message}`);
  }

  console.log("\n=== Rollback Complete ===");
  console.log("NEXT STEPS:");
  console.log("1. Run: tsx scripts/verify-upgrade.ts");
  console.log("2. Notify on-call channel");
  console.log("3. Review verification report in ./verification-reports/");
}

main().catch((error) => {
  console.error("[rollback] Fatal error:", error);
  process.exit(1);
});
