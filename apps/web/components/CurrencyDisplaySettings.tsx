'use client';

import {
  SUPPORTED_CURRENCIES,
  formatConverted,
  type CurrencyCode,
  type ExchangeRate,
} from '@/lib/currency';
import { useDisplayCurrency } from '@/lib/useDisplayCurrency';

// Issue #1037 — account-settings-style control for an optional display
// currency, plus the rate disclosure required alongside it. Purely
// presentational: never touches a contract call.
export function CurrencyDisplaySettings({
  currency,
  setCurrency,
  rate,
  loading,
  error,
}: ReturnType<typeof useDisplayCurrency>) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-2">
        <span className="text-muted uppercase tracking-wide">Display currency</span>
        <select
          value={currency ?? ''}
          onChange={(e) => setCurrency(e.target.value ? (e.target.value as CurrencyCode) : null)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm focus:border-accent focus:outline-none"
        >
          <option value="">XLM only (off)</option>
          {SUPPORTED_CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.label}
            </option>
          ))}
        </select>
      </label>

      {currency ? (
        loading ? (
          <span className="text-muted">Fetching exchange rate…</span>
        ) : error ? (
          <span className="text-danger">Couldn&apos;t load exchange rate: {error}</span>
        ) : rate ? (
          <RateDisclosure rate={rate} />
        ) : null
      ) : (
        <span className="text-muted">
          Amounts show in XLM only. Pick a currency for an approximate conversion alongside it.
        </span>
      )}
    </div>
  );
}

function RateDisclosure({ rate }: { rate: ExchangeRate }) {
  return (
    <span className="text-muted">
      1 XLM ≈ {formatConverted('10000000', rate)} · source: {rate.source} · as of{' '}
      {new Date(rate.asOf).toLocaleString()}
    </span>
  );
}
