/**
 * Integration tests for oracle-event-listener.ts
 *
 * Run with:
 *   node --import tsx/esm --test src/services/oracle-event-listener.test.ts
 *
 * All DB calls and RPC calls are replaced with in-memory stubs so no real
 * Postgres or Soroban node is needed.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── In-memory DB stub ─────────────────────────────────────────────────────────

interface FeedRow {
  importer_id: string | null;
  importer_address: string;
  required_collateral: string;
  previous_collateral: string;
  pct_change: string;
  tx_hash: string;
  ledger_sequence: number;
  set_by: string;
  emergency_override: boolean;
}

// Rows keyed by "tx_hash:importer_address" to simulate the unique constraint.
const feedStore = new Map<string, FeedRow>();
let listenerStateStore: number | null = null;

// Minimal pool stub that intercepts only the queries made by the listener.
const poolStub = {
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const s = sql.trim().replace(/\s+/g, " ");

    // getListenerState
    if (s.startsWith("SELECT last_ledger_sequence FROM listener_state")) {
      if (listenerStateStore === null) return { rows: [], rowCount: 0 };
      return { rows: [{ last_ledger_sequence: listenerStateStore }], rowCount: 1 };
    }

    // setListenerState
    if (s.startsWith("INSERT INTO listener_state")) {
      listenerStateStore = params?.[1] as number;
      return { rows: [], rowCount: 1 };
    }

    // importer_id lookup
    if (s.startsWith("SELECT id FROM importers WHERE stellar_address")) {
      const addr = params?.[0] as string;
      if (addr === "GTEST_IMPORTER_KNOWN") {
        return { rows: [{ id: "uuid-importer-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // INSERT INTO oracle_price_feed — honor ON CONFLICT DO NOTHING.
    if (s.startsWith("INSERT INTO oracle_price_feed")) {
      const [
        importerId,
        importerAddress,
        requiredCollateral,
        previousCollateral,
        pctChange,
        txHash,
        ledgerSequence,
        setBy,
        emergencyOverride,
      ] = params as [
        string | null,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        boolean,
      ];

      const key = `${txHash}:${importerAddress}`;
      if (feedStore.has(key)) return { rows: [], rowCount: 0 }; // conflict → do nothing

      feedStore.set(key, {
        importer_id: importerId,
        importer_address: importerAddress,
        required_collateral: requiredCollateral,
        previous_collateral: previousCollateral,
        pct_change: pctChange,
        tx_hash: txHash,
        ledger_sequence: ledgerSequence,
        set_by: setBy,
        emergency_override: emergencyOverride,
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  },
};

// ── Helpers to build mock Soroban event objects ────────────────────────────────

import { nativeToScVal, Address, xdr } from "@stellar/stellar-sdk";

function makeRequiredEvent(
  importerAddress: string,
  oldRequired: bigint,
  newRequired: bigint,
  txHash: string,
  ledger: number,
): object {
  return {
    id: `${ledger}-000000`,
    type: "contract",
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    contractId: "CTARIFFSHIELD",
    txHash,
    // Topics: [Symbol("required"), Address(importer)]
    topic: [
      nativeToScVal("required", { type: "symbol" }),
      new Address(importerAddress).toScVal(),
    ],
    // Data: (old_required: i128, new_required: i128) as a Vec/tuple
    value: nativeToScVal([oldRequired, newRequired]),
  };
}

function makeEmergencyEvent(
  importerAddress: string,
  oldRequired: bigint,
  newRequired: bigint,
  callerAddress: string,
  txHash: string,
  ledger: number,
): object {
  return {
    id: `${ledger}-000001`,
    type: "contract",
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    contractId: "CTARIFFSHIELD",
    txHash,
    topic: [
      nativeToScVal("EmergencyOracleUpdate", { type: "symbol" }),
      new Address(importerAddress).toScVal(),
    ],
    // Data: (old: i128, new: i128, ts: u64, caller: Address)
    value: nativeToScVal([oldRequired, newRequired, BigInt(Date.now()), callerAddress]),
  };
}

// ── Import listener functions ─────────────────────────────────────────────────

// We import the functions under test and use Module-level dependency injection
// via the exported functions that accept the pool and rpc as parameters.
import {
  insertOracleFeedRow,
  getListenerState,
  setListenerState,
  pollOracleEvents,
} from "./oracle-event-listener.js";

// Stellaraddresses for tests (valid Ed25519 public keys)
const IMPORTER_KNOWN   = "GBYSMQE3FKGKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKPKA";
const IMPORTER_UNKNOWN = "GCZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZB";
const CALLER_ADDR      = "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("oracle-event-listener — insertOracleFeedRow", () => {
  beforeEach(() => {
    feedStore.clear();
    listenerStateStore = null;
  });

  it("inserts a normal oracle event with correct pct_change", async () => {
    await insertOracleFeedRow({
      importerAddress: IMPORTER_KNOWN,
      oldRequired: 1_000_000n,
      newRequired: 1_200_000n,
      callerAddress: CALLER_ADDR,
      emergency: false,
      txHash: "abc123",
      ledgerSequence: 100,
    });

    const row = feedStore.get(`abc123:${IMPORTER_KNOWN}`);
    assert.ok(row, "row should be inserted");
    assert.equal(row!.required_collateral, "1200000");
    assert.equal(row!.previous_collateral, "1000000");
    // pct_change = (1200000 - 1000000) / 1000000 * 100 = 20.00
    assert.equal(parseFloat(row!.pct_change), 20.0);
    assert.equal(row!.emergency_override, false);
  });

  it("inserts an emergency oracle event with emergency_override=true", async () => {
    await insertOracleFeedRow({
      importerAddress: IMPORTER_KNOWN,
      oldRequired: 500_000n,
      newRequired: 750_000n,
      callerAddress: CALLER_ADDR,
      emergency: true,
      txHash: "emrg001",
      ledgerSequence: 200,
    });

    const row = feedStore.get(`emrg001:${IMPORTER_KNOWN}`);
    assert.ok(row);
    assert.equal(row!.emergency_override, true);
    assert.equal(row!.set_by, CALLER_ADDR);
  });

  it("silently ignores duplicate tx_hash + importer_address (ON CONFLICT DO NOTHING)", async () => {
    const base = {
      importerAddress: IMPORTER_KNOWN,
      oldRequired: 100n,
      newRequired: 200n,
      callerAddress: "",
      emergency: false,
      txHash: "dup001",
      ledgerSequence: 300,
    };

    await insertOracleFeedRow(base);
    await insertOracleFeedRow({ ...base, newRequired: 999n }); // second insert → ignored

    const row = feedStore.get(`dup001:${IMPORTER_KNOWN}`);
    // Value should be 200, not 999 (first write wins).
    assert.equal(row!.required_collateral, "200");
  });

  it("sets pct_change to 0 when previous_collateral is zero", async () => {
    await insertOracleFeedRow({
      importerAddress: IMPORTER_UNKNOWN,
      oldRequired: 0n,
      newRequired: 500_000n,
      callerAddress: "",
      emergency: false,
      txHash: "zero001",
      ledgerSequence: 400,
    });

    const row = feedStore.get(`zero001:${IMPORTER_UNKNOWN}`);
    assert.ok(row);
    assert.equal(parseFloat(row!.pct_change), 0);
  });
});

describe("oracle-event-listener — listener_state (replay-on-restart)", () => {
  beforeEach(() => {
    feedStore.clear();
    listenerStateStore = null;
  });

  it("returns null when no checkpoint exists (first run)", async () => {
    const state = await getListenerState();
    assert.equal(state, null);
  });

  it("persists and retrieves the last processed ledger", async () => {
    await setListenerState(12345);
    const state = await getListenerState();
    assert.equal(state, 12345);
  });

  it("overwrites with a newer ledger on update", async () => {
    await setListenerState(100);
    await setListenerState(200);
    assert.equal(await getListenerState(), 200);
  });
});

describe("oracle-event-listener — pollOracleEvents", () => {
  beforeEach(() => {
    feedStore.clear();
    listenerStateStore = null;
  });

  it("processes a batch of events and advances the checkpoint", async () => {
    // Start at ledger 500; current ledger is 520.
    await setListenerState(500);

    const mockRpc = {
      async getLatestLedger() {
        return { sequence: 520 };
      },
      async getEvents(_opts: unknown) {
        return {
          events: [
            makeRequiredEvent(IMPORTER_KNOWN, 1_000n, 1_100n, "tx001", 505),
            makeRequiredEvent(IMPORTER_KNOWN, 1_100n, 1_300n, "tx002", 510),
          ],
        };
      },
    };

    await pollOracleEvents(mockRpc as any);

    assert.equal(feedStore.size, 2, "two rows should be inserted");
    // Checkpoint should advance to min(520, 500 + MAX_WINDOW=200) = 520.
    assert.equal(await getListenerState(), 520);
  });

  it("replays missed events when restarting with no checkpoint (first run)", async () => {
    // No checkpoint → listener should compute fromLedger = current - INITIAL_LOOKBACK.
    const mockRpc = {
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async getEvents(_opts: unknown) {
        return {
          events: [
            makeRequiredEvent(IMPORTER_UNKNOWN, 0n, 500_000n, "replay001", 995),
          ],
        };
      },
    };

    await pollOracleEvents(mockRpc as any);

    assert.equal(feedStore.size, 1, "replayed event should be inserted");
    assert.ok(feedStore.has(`replay001:${IMPORTER_UNKNOWN}`));
  });

  it("skips events outside the target ledger window", async () => {
    await setListenerState(100);

    const mockRpc = {
      async getLatestLedger() {
        return { sequence: 150 };
      },
      async getEvents(_opts: unknown) {
        return {
          events: [
            makeRequiredEvent(IMPORTER_KNOWN, 1n, 2n, "inwindow", 120),
            // ledger 9999 is well beyond toLedger=150 → should be skipped
            makeRequiredEvent(IMPORTER_KNOWN, 2n, 3n, "outofwindow", 9999),
          ],
        };
      },
    };

    await pollOracleEvents(mockRpc as any);

    assert.ok(feedStore.has(`inwindow:${IMPORTER_KNOWN}`), "in-window event should be inserted");
    assert.ok(!feedStore.has(`outofwindow:${IMPORTER_KNOWN}`), "out-of-window event should be skipped");
  });

  it("does nothing when already up to date (fromLedger >= currentLedger)", async () => {
    await setListenerState(999);

    const mockRpc = {
      async getLatestLedger() {
        return { sequence: 999 };
      },
      async getEvents(_opts: unknown) {
        return { events: [] };
      },
    };

    await pollOracleEvents(mockRpc as any);
    assert.equal(feedStore.size, 0);
    // Checkpoint should remain unchanged.
    assert.equal(await getListenerState(), 999);
  });
});

describe("oracle-event-listener — pagination helpers (via oracle_price_feed rows)", () => {
  it("pct_change is calculated correctly for a decrease", async () => {
    await insertOracleFeedRow({
      importerAddress: IMPORTER_UNKNOWN,
      oldRequired: 2_000_000n,
      newRequired: 1_000_000n,
      callerAddress: "",
      emergency: false,
      txHash: "decrease001",
      ledgerSequence: 600,
    });

    const row = feedStore.get(`decrease001:${IMPORTER_UNKNOWN}`);
    assert.ok(row);
    // pct_change = (1000000 - 2000000) / 2000000 * 100 = -50.00
    assert.equal(parseFloat(row!.pct_change), -50.0);
  });
});
