/**
 * hts-rate-validator.ts
 *
 * Validates importer-declared duty rates against the USITC Harmonized Tariff
 * Schedule (HTS) Column 1 General Rate.
 *
 * Rate data is fetched from the USITC HTS online data API and cached in
 * Postgres for 7 days per HTS code.  An admin can bust the cache for specific
 * codes (or all codes) via POST /admin/refresh-hts-cache.
 *
 * Validation rules:
 *   • declared_rate < statutory_rate × (1 - 0.05)  → "underreported" (BLOCKING)
 *   • declared_rate > statutory_rate × (1 + 0.05)  → "overreported"  (WARNING)
 *   • HTS code not found in schedule               → "unknown"        (WARNING, skip)
 *   • USITC API unavailable                        → "api_unavailable" (WARNING, skip)
 */

import pino from "pino";
import { pool } from "../db.js";

const logger = pino({ name: "hts-rate-validator" });

/** Seven days in milliseconds. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tolerance band: 5 % (0.05). */
const TOLERANCE = 0.05;

export interface HtsLineItem {
  hts_code: string;
  declared_rate: number; // as a decimal fraction, e.g. 0.065 for 6.5%
}

export type ValidationStatus =
  | "ok"
  | "underreported"
  | "overreported"
  | "unknown_hts"
  | "api_unavailable";

export interface HtsValidationResult {
  hts_code: string;
  declared_rate: number;
  statutory_rate: number | null;
  status: ValidationStatus;
  /** Human-readable explanation. */
  message: string;
}

export interface HtsValidationSummary {
  /** Items that block the upload (underreported). */
  blocking: HtsValidationResult[];
  /** Items that produce a non-blocking warning. */
  warnings: HtsValidationResult[];
  /** Items that passed validation without issue. */
  passed: HtsValidationResult[];
  /** True when any blocking items exist. */
  hasBlockingErrors: boolean;
}

// ─── USITC HTS API ────────────────────────────────────────────────────────────
//
// The USITC HTS online endpoint returns duty rate info per HTS code.
// Endpoint: https://hts.usitc.gov/reststop/exportHts?fromSection=&toSection=&fromChapter=&toChapter=&htsCodes=<code>
// We parse the JSON "General Rate of Duty" field which is a string like "6.5%",
// "Free", or a compound expression.  We convert it to a decimal fraction.

const USITC_BASE = "https://hts.usitc.gov/reststop";

/**
 * Fetch the Column 1 General Rate from the USITC HTS online API.
 * Returns null when the code is not found or the API is unavailable.
 */
async function fetchStatutoryRate(
  htsCode: string,
): Promise<{ rate: number | null; unavailable: boolean }> {
  // Normalise code: strip punctuation for the query, keep original for display
  const normalised = htsCode.replace(/[^0-9]/g, "");
  const url = `${USITC_BASE}/exportHts?htsCodes=${encodeURIComponent(normalised)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });

    if (!resp.ok) {
      logger.warn({ htsCode, status: resp.status }, "USITC HTS API returned non-200");
      return { rate: null, unavailable: true };
    }

    // The API returns an array of objects; pick the first match.
    const data = (await resp.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0) {
      return { rate: null, unavailable: false }; // code not found
    }

    // Field names vary slightly between USITC API versions; try common candidates.
    const entry = data[0]!;
    const rawRate =
      (entry["col1General"] as string | undefined) ??
      (entry["generalRateOfDuty"] as string | undefined) ??
      (entry["Col1General"] as string | undefined) ??
      (entry["general"] as string | undefined);

    if (!rawRate) return { rate: null, unavailable: false };

    const parsed = parseDutyRateString(rawRate);
    return { rate: parsed, unavailable: false };
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.message.includes("timeout"));
    logger.warn({ htsCode, err: String(err) }, isTimeout ? "USITC HTS API timed out" : "USITC HTS API fetch error");
    return { rate: null, unavailable: true };
  }
}

/**
 * Parse a CBP/USITC duty rate string to a decimal fraction.
 *
 * Examples:
 *   "6.5%"      → 0.065
 *   "Free"      → 0
 *   "0%"        → 0
 *   "10 cents/kg + 6.5%"  → 0.065  (ad-valorem component only)
 *   "$1.50/kg"  → null              (specific duty, not ad-valorem; skip)
 */
export function parseDutyRateString(raw: string): number | null {
  const s = raw.trim().toLowerCase();

  if (s === "free" || s === "0%" || s === "0.0%") return 0;

  // Extract the first percentage value found.
  const pctMatch = s.match(/([\d]+(?:\.[\d]+)?)\s*%/);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]!);
    return isNaN(pct) ? null : pct / 100;
  }

  // Pure specific duty with no ad-valorem component — not comparable; skip.
  return null;
}

// ─── DB cache ─────────────────────────────────────────────────────────────────

interface CacheRow {
  statutory_rate: number | null;
  is_unavailable: boolean;
  fetched_at: Date;
}

async function getCached(htsCode: string): Promise<CacheRow | null> {
  const r = await pool.query<CacheRow>(
    `SELECT statutory_rate, is_unavailable, fetched_at
       FROM hts_rate_cache
      WHERE hts_code = $1
        AND fetched_at > now() - INTERVAL '7 days'`,
    [htsCode],
  );
  return r.rows[0] ?? null;
}

async function upsertCache(
  htsCode: string,
  rate: number | null,
  unavailable: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO hts_rate_cache (hts_code, statutory_rate, is_unavailable, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (hts_code)
     DO UPDATE SET statutory_rate = EXCLUDED.statutory_rate,
                   is_unavailable = EXCLUDED.is_unavailable,
                   fetched_at = EXCLUDED.fetched_at`,
    [htsCode, rate ?? null, unavailable],
  );
}

/** Bust cache for specific HTS codes, or all codes when codes array is empty. */
export async function bustHtsCache(htsCodes: string[]): Promise<number> {
  if (htsCodes.length === 0) {
    const r = await pool.query("DELETE FROM hts_rate_cache");
    return r.rowCount ?? 0;
  }
  const r = await pool.query(
    "DELETE FROM hts_rate_cache WHERE hts_code = ANY($1::text[])",
    [htsCodes],
  );
  return r.rowCount ?? 0;
}

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Look up the statutory rate for a single HTS code.
 * Checks the DB cache first; falls back to the USITC API and caches the result.
 */
async function resolveStatutoryRate(
  htsCode: string,
): Promise<{ rate: number | null; unavailable: boolean }> {
  const cached = await getCached(htsCode);
  if (cached) {
    return {
      rate: cached.statutory_rate ?? null,
      unavailable: cached.is_unavailable,
    };
  }

  const { rate, unavailable } = await fetchStatutoryRate(htsCode);
  await upsertCache(htsCode, rate, unavailable).catch((err) =>
    logger.error({ err, htsCode }, "Failed to upsert HTS rate cache"),
  );
  return { rate, unavailable };
}

/**
 * Validate an array of HTS line items against the USITC statutory rates.
 *
 * Returns a summary split into blocking errors, warnings, and passed items.
 */
export async function validateHtsRates(
  items: HtsLineItem[],
): Promise<HtsValidationSummary> {
  const results: HtsValidationResult[] = await Promise.all(
    items.map(async (item): Promise<HtsValidationResult> => {
      const { rate: statutory, unavailable } = await resolveStatutoryRate(item.hts_code);

      // API unavailable — warn but do not block
      if (unavailable) {
        return {
          hts_code: item.hts_code,
          declared_rate: item.declared_rate,
          statutory_rate: null,
          status: "api_unavailable",
          message: `USITC HTS API unavailable for ${item.hts_code}; skipping rate check`,
        };
      }

      // HTS code not found — warn but do not block
      if (statutory === null) {
        return {
          hts_code: item.hts_code,
          declared_rate: item.declared_rate,
          statutory_rate: null,
          status: "unknown_hts",
          message: `HTS code ${item.hts_code} not found in USITC schedule; skipping rate check`,
        };
      }

      const lower = statutory * (1 - TOLERANCE);
      const upper = statutory * (1 + TOLERANCE);

      if (item.declared_rate < lower) {
        return {
          hts_code: item.hts_code,
          declared_rate: item.declared_rate,
          statutory_rate: statutory,
          status: "underreported",
          message:
            `Declared rate ${(item.declared_rate * 100).toFixed(2)}% is more than 5% below ` +
            `statutory rate ${(statutory * 100).toFixed(2)}% for HTS ${item.hts_code}`,
        };
      }

      if (item.declared_rate > upper) {
        return {
          hts_code: item.hts_code,
          declared_rate: item.declared_rate,
          statutory_rate: statutory,
          status: "overreported",
          message:
            `Declared rate ${(item.declared_rate * 100).toFixed(2)}% is more than 5% above ` +
            `statutory rate ${(statutory * 100).toFixed(2)}% for HTS ${item.hts_code}`,
        };
      }

      return {
        hts_code: item.hts_code,
        declared_rate: item.declared_rate,
        statutory_rate: statutory,
        status: "ok",
        message: `HTS ${item.hts_code} rate OK`,
      };
    }),
  );

  const blocking = results.filter((r) => r.status === "underreported");
  const warnings = results.filter(
    (r) => r.status === "overreported" || r.status === "unknown_hts" || r.status === "api_unavailable",
  );
  const passed = results.filter((r) => r.status === "ok");

  return { blocking, warnings, passed, hasBlockingErrors: blocking.length > 0 };
}
