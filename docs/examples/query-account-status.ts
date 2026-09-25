/**
 * docs/examples/query-account-status.ts
 *
 * Demonstrates how to call getAccount() and getCollateralHistory() against
 * the TariffShield Soroban contract on Stellar Testnet to build a read-only
 * status dashboard for a specific importer.
 *
 * Run:
 *   npx ts-node docs/examples/query-account-status.ts
 *
 * Prerequisites:
 *   - Node.js 20+
 *   - npm install @tariff-shield/sdk @stellar/stellar-sdk
 *   - A deployed contract on Testnet (update CONTRACT_ID below)
 */

import { TariffShieldClient } from '@tariff-shield/sdk';

// ── Configuration ─────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.CONTRACT_ID ?? 'CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF';
const IMPORTER_ADDRESS = process.env.IMPORTER_ADDRESS ?? 'GA...your-importer-address...';

const client = new TariffShieldClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: CONTRACT_ID,
  networkPassphrase: 'Test SDF Network ; September 2015',
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Querying account status for: ${IMPORTER_ADDRESS}\n`);

  // ── getAccount ────────────────────────────────────────────────────────────
  // Returns the full on-chain state for an importer: bond ID, collateral
  // balances, whether a dispute is open, etc.  This is a simulation-only
  // call — no transaction is submitted and no fees are charged.
  const account = await client.getAccount(IMPORTER_ADDRESS);

  console.log('=== Account Status ===');
  console.log(`Bond ID:               ${account.bondId}`);
  console.log(`Collateral balance:    ${account.collateralBalance} stroops`);
  console.log(`Required collateral:   ${account.requiredCollateral} stroops`);
  console.log(`Reserve balance:       ${account.reserveBalance} stroops`);
  console.log(`Yield accrued:         ${account.yieldAccrued} stroops`);
  console.log(`Is clawbacked:         ${account.isClawbacked}`);

  // Dispute fields — non-zero when an open dispute exists.
  // disputeExpiresAt is a Unix timestamp (seconds).  Zero means no dispute window.
  if (account.disputeRaised) {
    const expiresDate = new Date(Number(account.disputeExpiresAt) * 1000);
    console.log(`\nDispute raised:        YES`);
    console.log(`Dispute expires:       ${expiresDate.toISOString()}`);
    console.log(`Pre-dispute required:  ${account.preDisputeRequired} stroops`);
  } else {
    console.log(`\nDispute raised:        No`);
  }

  // Collateral coverage ratio — useful for alerting when coverage drops below 1.
  if (account.requiredCollateral > 0n) {
    const coverageRatio =
      Number(account.collateralBalance) / Number(account.requiredCollateral);
    const pct = (coverageRatio * 100).toFixed(2);
    console.log(`\nCoverage ratio:        ${pct}%  (${coverageRatio >= 1 ? 'HEALTHY' : '⚠ UNDERFUNDED'})`);
  }

  // ── getCollateralHistory ──────────────────────────────────────────────────
  // Returns a rolling audit trail of every time required_collateral was
  // updated by the oracle.  Each entry has a `value` (stroops) and a
  // `timestamp` (Unix seconds).  Entries are ordered oldest-first.
  const history = await client.getCollateralHistory(IMPORTER_ADDRESS);

  console.log('\n=== Collateral History ===');
  if (history.length === 0) {
    console.log('No collateral history recorded yet.');
  } else {
    for (const entry of history) {
      const date = new Date(Number(entry.timestamp) * 1000).toISOString();
      console.log(`  ${date}  →  ${entry.value} stroops`);
    }

    // Spot whether required collateral has been trending up or down.
    const first = history[0]!.value;
    const last = history[history.length - 1]!.value;
    const trend = last > first ? '↑ increasing' : last < first ? '↓ decreasing' : '→ stable';
    console.log(`\nTrend: ${trend} (${history[0]!.value} → ${last})`);
  }
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
