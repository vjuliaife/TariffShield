#!/usr/bin/env tsx
/**
 * scripts/list-wasm-hashes.ts
 *
 * Lists all wasm hashes for the TariffShield contract from deployment history
 * to help identify the correct previous hash for rollback operations.
 *
 * Usage:
 *   tsx scripts/list-wasm-hashes.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface DeploymentRecord {
  network: string;
  contractId: string;
  wasmHash: string;
  version?: string;
  deployedAt: string;
  deployedBy?: string;
}

async function main() {
  const historyPath = path.join(process.cwd(), "deployments", "history.json");

  if (!fs.existsSync(historyPath)) {
    console.error("ERROR: deployments/history.json not found");
    console.error(
      "\nThis file is created automatically by deployment scripts.",
    );
    console.error(
      "If you need to rollback and this file doesn't exist, you must",
    );
    console.error(
      "manually query the Stellar network for previous wasm hashes.",
    );
    process.exit(1);
  }

  const historyContent = fs.readFileSync(historyPath, "utf-8");
  const history: DeploymentRecord[] = JSON.parse(historyContent);

  if (history.length === 0) {
    console.error("ERROR: No deployment history found");
    process.exit(1);
  }

  const contractId = process.env.TARIFF_SHIELD_CONTRACT_ID;
  const network = process.env.STELLAR_NETWORK || "testnet";

  // Filter by current contract and network if available
  let relevantDeployments = history;
  if (contractId) {
    relevantDeployments = history.filter((d) => d.contractId === contractId);
  }
  if (network) {
    relevantDeployments = relevantDeployments.filter(
      (d) => d.network === network,
    );
  }

  if (relevantDeployments.length === 0) {
    console.log("No deployments found for current contract/network");
    console.log("\nShowing all deployments:");
    relevantDeployments = history;
  }

  console.log("=== TariffShield Contract Deployment History ===\n");
  console.log(`Total deployments: ${relevantDeployments.length}\n`);

  relevantDeployments
    .sort(
      (a, b) =>
        new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime(),
    )
    .forEach((deployment, index) => {
      const isCurrent = index === 0;
      const marker = isCurrent ? " (CURRENT)" : "";

      console.log(`${index + 1}. ${marker}`);
      console.log(`   WASM Hash: ${deployment.wasmHash}`);
      console.log(`   Contract:  ${deployment.contractId}`);
      console.log(`   Network:   ${deployment.network}`);
      console.log(`   Version:   ${deployment.version || "unknown"}`);
      console.log(`   Deployed:  ${deployment.deployedAt}`);
      console.log(`   By:        ${deployment.deployedBy || "unknown"}`);
      console.log("");
    });

  if (relevantDeployments.length >= 2) {
    const previousDeployment = relevantDeployments[1];
    console.log("=== Quick Rollback Command ===");
    console.log(
      `tsx scripts/rollback-upgrade.ts --previous-wasm-hash ${previousDeployment.wasmHash} --contract-id ${previousDeployment.contractId}`,
    );
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
