import client from "prom-client";
import { pino } from "pino";
import { getActiveBonds } from "../db.js";
import { getBondOnChain } from "../stellar.js";

const logger = pino({
  name: "reconciliation-job",
  level: "info",
});

// Prometheus metrics
const driftGauge = new client.Gauge({
  name: "contract_balance_drift_count",
  help: "Number of bonds where DB balance differs from on-chain balance by > 0.1%",
});

const runsCounter = new client.Counter({
  name: "reconciliation_runs_total",
  help: "Total number of balance reconciliation runs",
  labelNames: ["outcome"],
});

let isRunning = false;

/**
 * Executes a single reconciliation pass across all active bonds.
 */
export async function reconcileBalances(): Promise<void> {
  if (isRunning) {
    logger.warn("Reconciliation job is already running, skipping this interval.");
    return;
  }

  isRunning = true;
  let driftCount = 0;
  let hasError = false;

  try {
    logger.info("Starting balance reconciliation run...");
    const bonds = await getActiveBonds();

    for (const bond of bonds) {
      try {
        const onChainBalanceStr = await getBondOnChain(bond.stellarAddress);
        const dbBalance = parseFloat(bond.dbBalance);
        const onChainBalance = parseFloat(onChainBalanceStr);

        if (onChainBalance === 0) {
          if (dbBalance !== 0) {
            logDrift(bond.bondId, dbBalance, onChainBalance, 1);
            driftCount++;
          }
          continue;
        }

        const driftPercent = Math.abs(dbBalance - onChainBalance) / onChainBalance;

        if (driftPercent > 0.001) {
          logDrift(bond.bondId, dbBalance, onChainBalance, driftPercent);
          driftCount++;
        }
      } catch (err) {
        logger.error({ err, bondId: bond.bondId }, "Failed to reconcile bond");
        hasError = true;
      }
    }

    driftGauge.set(driftCount);
    runsCounter.inc({ outcome: hasError ? "partial_failure" : "success" });
    logger.info({ driftCount, hasError }, "Reconciliation run completed.");
  } catch (err) {
    logger.error({ err }, "Fatal error in reconciliation job");
    runsCounter.inc({ outcome: "error" });
  } finally {
    isRunning = false;
  }
}

function logDrift(bondId: string, dbBalance: number, onChainBalance: number, driftPercent: number) {
  logger.error(
    { 
      bondId, 
      dbBalance, 
      onChainBalance, 
      driftPercent: (driftPercent * 100).toFixed(2) + "%" 
    },
    "Balance drift detected for bond!"
  );
}

/**
 * Starts the reconciliation job on a 5-minute interval.
 */
export function startReconciliationJob(): void {
  logger.info("Scheduling balance reconciliation job (every 5m)");
  // Run immediately on boot
  reconcileBalances().catch((err) => logger.error({ err }, "Initial reconciliation run failed"));
  
  // Schedule subsequent runs
  setInterval(() => {
    reconcileBalances().catch((err) => logger.error({ err }, "Interval reconciliation run failed"));
  }, 5 * 60 * 1000);
}
