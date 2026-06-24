import { pino } from "pino";
import client from "prom-client";
import * as Sentry from "@sentry/node";
import { getCurrentLedgerSequence } from "./stellar.js";
import { getLastProcessedLedger, updateLastProcessedLedger } from "./db.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// Initialize Prometheus gauge for indexer lag
export const indexerLagGauge = new client.Gauge({
  name: "contract_event_indexer_lag_ledgers",
  help: "Difference between the latest ledger sequence on-chain and the last processed ledger by the indexer",
});

let intervalId: NodeJS.Timeout | null = null;

/**
 * Starts the background polling interval to monitor indexer lag.
 * Refreshes every 30 seconds.
 */
export async function startIndexer(): Promise<void> {
  if (intervalId) {
    logger.warn("Indexer background worker is already running");
    return;
  }

  logger.info("[indexer] Starting background event indexer monitor...");

  // Run the first check immediately
  try {
    await checkLagAndIndex();
  } catch (err) {
    logger.error({ err }, "[indexer] First check failed");
    Sentry.captureException(err);
  }

  // Poll every 30 seconds
  intervalId = setInterval(async () => {
    try {
      await checkLagAndIndex();
    } catch (err) {
      logger.error({ err }, "[indexer] Error in contract event indexer monitoring cycle");
      Sentry.captureException(err);
    }
  }, 30000);
}

/**
 * Stops the background polling interval.
 */
export function stopIndexer(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("[indexer] Stopped background event indexer monitor");
  }
}

/**
 * Performs a single cycle of the indexer monitoring check.
 * 1. Fetches current ledger sequence on-chain.
 * 2. Fetches last processed ledger sequence from the DB.
 * 3. Computes lag and reports it to the Prometheus gauge.
 * 4. Emits warning/error structured logs if threshold is crossed.
 * 5. Advances the indexer state in the database (unless INDEXER_STALL=true).
 */
async function checkLagAndIndex(): Promise<void> {
  const currentLedger = await getCurrentLedgerSequence();
  let lastProcessed = await getLastProcessedLedger();

  // If table is empty, initialize it with the current ledger sequence
  if (lastProcessed === null) {
    lastProcessed = currentLedger;
    await updateLastProcessedLedger(lastProcessed);
    logger.info({ lastProcessedLedger: lastProcessed }, "[indexer] Initialized last_processed_ledger in database");
  }

  const lag = currentLedger - lastProcessed;

  // Update Prometheus gauge
  indexerLagGauge.set(lag);

  // Emit structured Pino log depending on lag thresholds
  if (lag > 10) {
    logger.error(
      { lagLedgers: lag, lastProcessedLedger: lastProcessed, currentLedger },
      "Indexer lag exceeds critical threshold (> 10 blocks)"
    );
  } else if (lag > 5) {
    logger.warn(
      { lagLedgers: lag, lastProcessedLedger: lastProcessed, currentLedger },
      "Indexer lag exceeds warning threshold (> 5 blocks)"
    );
  } else {
    logger.debug(
      { lagLedgers: lag, lastProcessedLedger: lastProcessed, currentLedger },
      "Indexer lag is within normal limits"
    );
  }

  // Update last processed sequence in the DB if not stalled
  if (process.env.INDEXER_STALL === "true") {
    logger.warn(
      { lagLedgers: lag, lastProcessedLedger: lastProcessed, currentLedger },
      "[indexer] Indexer stall simulated (INDEXER_STALL=true). Skipping ledger progression update."
    );
  } else {
    await updateLastProcessedLedger(currentLedger);
  }
}
