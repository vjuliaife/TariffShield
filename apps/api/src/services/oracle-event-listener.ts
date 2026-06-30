/**
 * oracle-event-listener.ts
 *
 * Subscribes to the TariffShield Soroban contract and persists every
 * `set_required_collateral` event into the `oracle_price_feed` PostgreSQL
 * table for durable, compliance-grade audit storage.
 *
 * Resilience:
 *   - The last processed ledger sequence is stored in `listener_state` and
 *     read on startup, so the listener replays any events missed during downtime.
 *   - Duplicate events (same tx_hash + importer_address) are silently ignored
 *     via the unique index on oracle_price_feed.
 *   - RPC/DB errors are logged and do not crash the process; the next poll
 *     will retry from the same checkpoint.
 *
 * Event topics emitted by the contract:
 *   Normal update  : [Symbol("required"), Address(importer)]
 *                    data: (old_required: i128, new_required: i128)
 *   Emergency update: [Symbol("EmergencyOracleUpdate"), Address(importer)]
 *                    data: (old: i128, new: i128, ts: u64, caller: Address)
 *
 * The listener handles both event shapes.
 */

import pino from "pino";
import * as Sentry from "@sentry/node";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { pool } from "../db.js";
import { env } from "../config/env.js";
import { createRpcServer } from "../lib/soroban/rpcClient.js";

const logger = pino({ name: "oracle-event-listener" });

// ── Constants ─────────────────────────────────────────────────────────────────

/** Postgres primary key used in listener_state. */
const STATE_KEY = "oracle_event_listener";

/** How often to poll for new events (ms). */
const POLL_INTERVAL_MS = 12_000; // ~2 Stellar ledgers at 5 s/ledger

/** Maximum ledgers to scan per poll to avoid overwhelming the RPC node. */
const MAX_LEDGER_WINDOW = 200;

/** Number of ledgers to look back on first startup (before any state exists). */
const INITIAL_LOOKBACK_LEDGERS = 720; // ~1 hour

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OracleFeedRow {
  id: string;
  importer_id: string | null;
  importer_address: string;
  required_collateral: string;
  previous_collateral: string;
  pct_change: string;
  tx_hash: string;
  ledger_sequence: number;
  set_by: string;
  emergency_override: boolean;
  created_at: Date;
}

// ── State management ──────────────────────────────────────────────────────────

export async function getListenerState(): Promise<number | null> {
  const r = await pool.query<{ last_ledger_sequence: number }>(
    "SELECT last_ledger_sequence FROM listener_state WHERE id = $1",
    [STATE_KEY],
  );
  return r.rows[0]?.last_ledger_sequence ?? null;
}

export async function setListenerState(ledgerSequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO listener_state (id, last_ledger_sequence, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id)
     DO UPDATE SET last_ledger_sequence = EXCLUDED.last_ledger_sequence,
                   updated_at = now()`,
    [STATE_KEY, ledgerSequence],
  );
}

// ── Event parsing ─────────────────────────────────────────────────────────────

interface ParsedOracleEvent {
  importerAddress: string;
  oldRequired: bigint;
  newRequired: bigint;
  /** Address of the caller (set_by); available in emergency events. */
  callerAddress: string;
  emergency: boolean;
  txHash: string;
  ledgerSequence: number;
}

/**
 * Attempt to extract oracle event data from a raw Soroban event.
 * Returns null when the event does not match either expected shape.
 */
function parseOracleEvent(event: rpc.Api.EventRecord): ParsedOracleEvent | null {
  try {
    // Topics are XDR-encoded ScVal strings in the API response.
    const topics = event.topic; // ScVal[]

    if (!topics || topics.length < 2) return null;

    // Topic[0] is the event name symbol.
    const topicSymbol = scValToNative(topics[0]!) as unknown;
    const isNormal = topicSymbol === "required";
    const isEmergency = topicSymbol === "EmergencyOracleUpdate";

    if (!isNormal && !isEmergency) return null;

    // Topic[1] is the importer Address ScVal.
    const importerAddress = scValToNative(topics[1]!) as string;
    if (!importerAddress || typeof importerAddress !== "string") return null;

    // Data is a tuple ScVal.
    const dataVal = event.value; // ScVal
    if (!dataVal) return null;

    const dataNative = scValToNative(dataVal) as unknown[];
    if (!Array.isArray(dataNative) || dataNative.length < 2) return null;

    const oldRequired = BigInt(String(dataNative[0]));
    const newRequired = BigInt(String(dataNative[1]));

    // Emergency events have (old, new, ts, caller) in the data tuple.
    let callerAddress = "";
    if (isEmergency && dataNative.length >= 4) {
      callerAddress = String(dataNative[3]);
    }

    return {
      importerAddress,
      oldRequired,
      newRequired,
      callerAddress,
      emergency: isEmergency,
      txHash: event.txHash,
      ledgerSequence: event.ledger,
    };
  } catch (err) {
    logger.warn({ err, eventId: event.id }, "Failed to parse oracle event");
    return null;
  }
}

// ── DB insertion ──────────────────────────────────────────────────────────────

/**
 * Persist a parsed oracle event to oracle_price_feed.
 * Resolves the importer_id FK from the importers table by stellar_address.
 * Duplicate tx_hash + importer_address pairs are silently ignored.
 */
export async function insertOracleFeedRow(parsed: ParsedOracleEvent): Promise<void> {
  // Resolve importer_id (nullable — address may not exist in the DB yet).
  const importerRow = await pool.query<{ id: string }>(
    "SELECT id FROM importers WHERE stellar_address = $1",
    [parsed.importerAddress],
  );
  const importerId: string | null = importerRow.rows[0]?.id ?? null;

  const prevCollateral = parsed.oldRequired;
  const newCollateral = parsed.newRequired;

  const pctChange =
    prevCollateral === 0n
      ? 0
      : Number(((newCollateral - prevCollateral) * 10000n) / prevCollateral) / 100;

  await pool.query(
    `INSERT INTO oracle_price_feed
       (importer_id, importer_address, required_collateral, previous_collateral,
        pct_change, tx_hash, ledger_sequence, set_by, emergency_override)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tx_hash, importer_address) DO NOTHING`,
    [
      importerId,
      parsed.importerAddress,
      newCollateral.toString(),
      prevCollateral.toString(),
      pctChange.toFixed(4),
      parsed.txHash,
      parsed.ledgerSequence,
      parsed.callerAddress,
      parsed.emergency,
    ],
  );
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

/**
 * Perform a single poll cycle:
 *  1. Determine the start ledger from checkpoint (or current - lookback on first run).
 *  2. Query Soroban RPC for contract events in that window.
 *  3. Parse and insert each oracle event.
 *  4. Advance the checkpoint to the latest scanned ledger.
 */
export async function pollOracleEvents(rpcServer: rpc.Server): Promise<void> {
  const latest = await rpcServer.getLatestLedger();
  const currentLedger = latest.sequence;

  let fromLedger = await getListenerState();

  if (fromLedger === null) {
    // First run — look back to catch any recent events.
    fromLedger = Math.max(1, currentLedger - INITIAL_LOOKBACK_LEDGERS);
    logger.info(
      { fromLedger, currentLedger },
      "[oracle-listener] No checkpoint found — replaying from initial lookback",
    );
  }

  // Nothing new to process.
  if (fromLedger >= currentLedger) return;

  // Cap the window to avoid overloading the RPC node.
  const toLedger = Math.min(currentLedger, fromLedger + MAX_LEDGER_WINDOW);

  logger.debug(
    { fromLedger, toLedger, currentLedger },
    "[oracle-listener] Polling events",
  );

  const response = await rpcServer.getEvents({
    startLedger: fromLedger + 1,
    filters: [
      {
        type: "contract",
        contractIds: [env.TARIFF_SHIELD_CONTRACT_ID],
        topics: [
          // Normal oracle update: ["required", <importer_address>]
          ["required", "*"],
          // Emergency oracle update: ["EmergencyOracleUpdate", <importer_address>]
          ["EmergencyOracleUpdate", "*"],
        ],
      },
    ],
    limit: 200,
  });

  let inserted = 0;
  let skipped = 0;

  for (const event of response.events) {
    // Only process events within our target window.
    if (event.ledger > toLedger) break;

    const parsed = parseOracleEvent(event);
    if (!parsed) {
      skipped++;
      continue;
    }

    try {
      await insertOracleFeedRow(parsed);
      inserted++;
    } catch (err) {
      logger.error(
        { err, txHash: parsed.txHash, importer: parsed.importerAddress },
        "[oracle-listener] Failed to insert feed row",
      );
      Sentry.captureException(err);
    }
  }

  await setListenerState(toLedger);

  if (inserted > 0 || skipped > 0) {
    logger.info(
      { fromLedger: fromLedger + 1, toLedger, inserted, skipped },
      "[oracle-listener] Poll cycle complete",
    );
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let intervalId: NodeJS.Timeout | null = null;

export async function startOracleEventListener(): Promise<void> {
  if (intervalId) {
    logger.warn("[oracle-listener] Already running");
    return;
  }

  logger.info("[oracle-listener] Starting oracle price feed event listener");

  const rpcServer = createRpcServer(env.STELLAR_RPC_URL);

  // Run immediately on start to replay any missed events.
  try {
    await pollOracleEvents(rpcServer);
  } catch (err) {
    logger.error({ err }, "[oracle-listener] First poll failed");
    Sentry.captureException(err);
  }

  intervalId = setInterval(async () => {
    try {
      await pollOracleEvents(rpcServer);
    } catch (err) {
      logger.error({ err }, "[oracle-listener] Poll cycle error");
      Sentry.captureException(err);
    }
  }, POLL_INTERVAL_MS);
}

export function stopOracleEventListener(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("[oracle-listener] Stopped");
  }
}
