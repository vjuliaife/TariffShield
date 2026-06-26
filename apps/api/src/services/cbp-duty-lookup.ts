import pino from "pino";
import { env } from "../config/env.js";

const logger = pino({ name: "cbp-duty-lookup" });

// In-memory map for caching
const cache = new Map<string, { rate: number; expiresAt: number }>();

export type CbpLookupResult = {
  htsCode: string;
  dutyRate: number | null;
  source: "cache" | "api" | "fallback";
};

export async function lookupCbpDutyRate(htsCode: string): Promise<CbpLookupResult> {
  // Check cache
  const cached = cache.get(htsCode);
  if (cached && cached.expiresAt > Date.now()) {
    return { htsCode, dutyRate: cached.rate, source: "cache" };
  }

  try {
    // In a real app, this queries the CBP ACE trade data API or HTS online schedule endpoint
    // We'll mock the response based on the HTS code for demonstration purposes
    const mockRate = generateMockRateForHts(htsCode);
    
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Cache for 24 hours
    cache.set(htsCode, { rate: mockRate, expiresAt: Date.now() + 86400 * 1000 });

    return { htsCode, dutyRate: mockRate, source: "api" };
  } catch (error) {
    logger.error({ err: error, htsCode }, "Failed to lookup CBP duty rate");
    return { htsCode, dutyRate: null, source: "fallback" };
  }
}

function generateMockRateForHts(htsCode: string): number {
  // Deterministic mock rate based on first 4 digits
  const prefix = parseInt(htsCode.substring(0, 4), 10) || 1000;
  return (prefix % 25) / 100.0; // returns 0.00 to 0.24 (0% to 24%)
}
