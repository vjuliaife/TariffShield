'use client';

// Issue #1037 — cross-border currency conversion display. Purely
// presentational: converts the on-chain XLM (base token) collateral figures
// into an importer's preferred display currency for context only. The
// base-token amount always remains the source of truth.

export const SUPPORTED_CURRENCIES = [
  { code: 'USD', label: 'US Dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'NGN', label: 'Nigerian Naira' },
  { code: 'INR', label: 'Indian Rupee' },
  { code: 'CAD', label: 'Canadian Dollar' },
  { code: 'JPY', label: 'Japanese Yen' },
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]['code'];

const PREF_KEY = 'tariffshield_display_currency';

export function getPreferredCurrency(): CurrencyCode | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(PREF_KEY);
  return SUPPORTED_CURRENCIES.some((c) => c.code === raw) ? (raw as CurrencyCode) : null;
}

export function setPreferredCurrency(code: CurrencyCode | null): void {
  if (typeof window === 'undefined') return;
  if (code === null) {
    window.localStorage.removeItem(PREF_KEY);
  } else {
    window.localStorage.setItem(PREF_KEY, code);
  }
}

export interface ExchangeRate {
  currency: CurrencyCode;
  /** Units of `currency` per 1 XLM. */
  rate: number;
  asOf: string;
  source: string;
}

const RATE_CACHE_TTL_MS = 5 * 60 * 1000;
const rateCache = new Map<CurrencyCode, { data: ExchangeRate; fetchedAt: number }>();

const RATE_SOURCE_LABEL = 'CoinGecko (stellar → fiat spot price)';

// Fetches the current XLM → `currency` spot rate, cached in-memory for
// RATE_CACHE_TTL_MS to avoid refetching on every render.
export async function fetchXlmExchangeRate(currency: CurrencyCode): Promise<ExchangeRate> {
  const cached = rateCache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL_MS) {
    return cached.data;
  }

  const vsCurrency = currency.toLowerCase();
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=${vsCurrency}&include_last_updated_at=true`
  );
  if (!res.ok) throw new Error(`Exchange rate lookup failed (HTTP ${res.status})`);
  const body = await res.json();
  const rate = body?.stellar?.[vsCurrency];
  const lastUpdatedUnix = body?.stellar?.last_updated_at;
  if (typeof rate !== 'number') throw new Error(`No exchange rate available for ${currency}`);
  const asOf =
    typeof lastUpdatedUnix === 'number'
      ? new Date(lastUpdatedUnix * 1000).toISOString()
      : new Date().toISOString();
  const data: ExchangeRate = { currency, rate, asOf, source: RATE_SOURCE_LABEL };
  rateCache.set(currency, { data, fetchedAt: Date.now() });
  return data;
}

/** Formats a stroops amount converted into `rate.currency` using the given rate. */
export function formatConverted(stroops: string | bigint, rate: ExchangeRate): string {
  const xlm = Number(typeof stroops === 'bigint' ? stroops : BigInt(stroops)) / 1e7;
  const amount = xlm * rate.rate;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: rate.currency,
      maximumFractionDigits: amount >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${rate.currency}`;
  }
}
