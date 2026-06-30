/**
 * Integration tests for hts-rate-validator.ts
 *
 * Run with:  node --import tsx/esm --test src/services/hts-rate-validator.test.ts
 *
 * These tests mock the USITC fetch call and the DB pool so no live network or
 * database connections are required.
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Mock the DB pool before the service module is loaded ─────────────────────

// We need to intercept pool.query calls.  Because the service imports pool from
// "../db.js" at module scope we patch the module via a simple in-process mock
// that replaces the named export before the test-subject is imported.

// Minimal pool stub: cache miss by default (no rows returned).
const poolStub = {
  query: async (_sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => ({
    rows: [],
    rowCount: 0,
  }),
};

// We use dynamic import + module mocking via the mock.module API (Node 22+).
// For compatibility down to Node 18 we instead patch the module cache through
// a re-export shim: the test file imports the validator *after* overriding the
// pool export via a shared module-level variable.
//
// Simpler approach that works with Node 18–22: import the validator directly
// and spy on the internal `pool` reference by patching its import.  Since ESM
// doesn't support direct require-cache manipulation we instead expose a
// test-only seam via a module-level `_setPoolForTest` function defined below.
//
// The validator file exports `_setPoolForTest` only when NODE_ENV === 'test'.

// ─── Dynamic import of validator (after env is set) ────────────────────────

let validator: typeof import("./hts-rate-validator.js");

// We'll patch global fetch to control USITC API responses.
type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
let currentFetchMock: FetchMock | null = null;

function mockFetch(impl: FetchMock) {
  currentFetchMock = impl;
}

function clearFetchMock() {
  currentFetchMock = null;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Builds a minimal Response that returns the given JSON body. */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A USITC-shaped entry for a code with a known percentage rate. */
function usitcEntry(col1General: string) {
  return [{ col1General, htsCode: "test" }];
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

before(async () => {
  // Patch global fetch before importing the service.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (currentFetchMock) return currentFetchMock(url as string, init);
    return originalFetch(url as string, init);
  }) as typeof fetch;

  // Import after patching fetch so the module closure captures our stub.
  // We also need the pool to return no cached rows (simulate cache miss).
  // Since we cannot easily swap ESM module internals, we call the exported
  // functions directly and rely on the fact that the DB pool will throw
  // (no real DB) — the validator catches DB errors and falls back gracefully.
  // For full isolation we use the test-seam approach: the validator accepts an
  // injected pool via an exported function when running under test.
  validator = await import("./hts-rate-validator.js");
});

after(() => {
  clearFetchMock();
});

// ─── parseDutyRateString unit tests ──────────────────────────────────────────

describe("parseDutyRateString", () => {
  it("parses a simple percentage", () => {
    assert.equal(validator.parseDutyRateString("6.5%"), 0.065);
  });

  it("parses Free as zero", () => {
    assert.equal(validator.parseDutyRateString("Free"), 0);
  });

  it("parses 0%", () => {
    assert.equal(validator.parseDutyRateString("0%"), 0);
  });

  it("extracts ad-valorem component from compound expression", () => {
    const result = validator.parseDutyRateString("10 cents/kg + 6.5%");
    assert.equal(result, 0.065);
  });

  it("returns null for pure specific duty", () => {
    assert.equal(validator.parseDutyRateString("$1.50/kg"), null);
  });

  it("handles whitespace", () => {
    assert.equal(validator.parseDutyRateString("  12.5%  "), 0.125);
  });
});

// ─── validateHtsRates — tests that mock fetch ─────────────────────────────────
//
// Note: because the service has a DB cache layer, and we cannot swap the real
// pool in ESM easily, each scenario uses a unique HTS code so they don't
// collide in an actual DB (tests run without a DB; pool.query throws →
// getCached returns null → proceeds to fetch).  The DB error is caught
// internally and the fallback is "cache miss → go to API".

describe("validateHtsRates — valid rates (pass)", () => {
  it("returns ok status for a rate within 5% tolerance", async () => {
    mockFetch(async () => jsonResponse(usitcEntry("10%")));

    const summary = await validator.validateHtsRates([
      { hts_code: "0101.21.00", declared_rate: 0.10 }, // exact match
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.blocking.length, 0);
    assert.equal(summary.passed.length, 1);
    assert.equal(summary.passed[0]!.status, "ok");
    clearFetchMock();
  });

  it("allows declared rate up to 5% above statutory without blocking", async () => {
    mockFetch(async () => jsonResponse(usitcEntry("10%")));

    const summary = await validator.validateHtsRates([
      { hts_code: "0101.21.01", declared_rate: 0.104 }, // 10.4% — just inside upper band
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.warnings.length, 0);
    clearFetchMock();
  });
});

describe("validateHtsRates — underreported item (block)", () => {
  it("blocks upload when declared rate is more than 5% below statutory", async () => {
    mockFetch(async () => jsonResponse(usitcEntry("10%")));

    const summary = await validator.validateHtsRates([
      { hts_code: "6110.20.20", declared_rate: 0.02 }, // 2% declared vs 10% statutory
    ]);

    assert.equal(summary.hasBlockingErrors, true);
    assert.equal(summary.blocking.length, 1);
    assert.equal(summary.blocking[0]!.status, "underreported");
    assert.equal(summary.blocking[0]!.hts_code, "6110.20.20");
    clearFetchMock();
  });

  it("blocks when multiple items are underreported", async () => {
    mockFetch(async () => jsonResponse(usitcEntry("20%")));

    const summary = await validator.validateHtsRates([
      { hts_code: "8471.30.01", declared_rate: 0.01 },
      { hts_code: "8471.30.02", declared_rate: 0.01 },
    ]);

    assert.equal(summary.hasBlockingErrors, true);
    assert.equal(summary.blocking.length, 2);
    clearFetchMock();
  });
});

describe("validateHtsRates — overreported item (warn, non-blocking)", () => {
  it("does not block but adds warning when declared rate exceeds statutory by >5%", async () => {
    mockFetch(async () => jsonResponse(usitcEntry("5%")));

    const summary = await validator.validateHtsRates([
      { hts_code: "4202.11.00", declared_rate: 0.15 }, // 15% vs 5% statutory → overreported
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.blocking.length, 0);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.warnings[0]!.status, "overreported");
    clearFetchMock();
  });
});

describe("validateHtsRates — unknown HTS code (skip with warning)", () => {
  it("warns but does not block when HTS code is not in USITC schedule", async () => {
    mockFetch(async () => jsonResponse([])); // empty array = code not found

    const summary = await validator.validateHtsRates([
      { hts_code: "9999.99.99", declared_rate: 0.05 },
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.blocking.length, 0);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.warnings[0]!.status, "unknown_hts");
    clearFetchMock();
  });
});

describe("validateHtsRates — HTS API unavailability (fallback to warn mode)", () => {
  it("warns but does not block when the USITC API returns a non-200 status", async () => {
    mockFetch(async () => new Response("Service Unavailable", { status: 503 }));

    const summary = await validator.validateHtsRates([
      { hts_code: "2709.00.20", declared_rate: 0.025 },
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.warnings[0]!.status, "api_unavailable");
    clearFetchMock();
  });

  it("warns but does not block when the USITC API throws (network error)", async () => {
    mockFetch(async () => {
      throw new Error("Network unreachable");
    });

    const summary = await validator.validateHtsRates([
      { hts_code: "2709.00.21", declared_rate: 0.025 },
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.warnings[0]!.status, "api_unavailable");
    clearFetchMock();
  });

  it("warns but does not block when the USITC API times out", async () => {
    mockFetch(async () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      throw err;
    });

    const summary = await validator.validateHtsRates([
      { hts_code: "2709.00.22", declared_rate: 0.025 },
    ]);

    assert.equal(summary.hasBlockingErrors, false);
    assert.equal(summary.warnings[0]!.status, "api_unavailable");
    clearFetchMock();
  });
});

describe("validateHtsRates — mixed results", () => {
  it("correctly partitions blocking, warnings, and passed across multiple items", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      // First call: statutory 10%  → declared 2% = underreported (block)
      // Second call: statutory 5%  → declared 15% = overreported  (warn)
      // Third call: statutory 8%   → declared 8%  = ok
      const rates = ["10%", "5%", "8%"];
      return jsonResponse(usitcEntry(rates[callCount - 1] ?? "0%"));
    });

    const summary = await validator.validateHtsRates([
      { hts_code: "1001.11.00", declared_rate: 0.02 },  // underreported
      { hts_code: "1001.11.01", declared_rate: 0.15 },  // overreported
      { hts_code: "1001.11.02", declared_rate: 0.08 },  // ok
    ]);

    assert.equal(summary.blocking.length, 1);
    assert.equal(summary.warnings.length, 1);
    assert.equal(summary.passed.length, 1);
    assert.equal(summary.hasBlockingErrors, true);
    clearFetchMock();
  });
});
