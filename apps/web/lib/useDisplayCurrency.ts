'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchXlmExchangeRate,
  getPreferredCurrency,
  setPreferredCurrency,
  type CurrencyCode,
  type ExchangeRate,
} from './currency';

// Issue #1037 — reads/writes the preferred display currency and keeps its
// XLM exchange rate in sync. `currency === null` means "off" (default).
export function useDisplayCurrency() {
  const [currency, setCurrencyState] = useState<CurrencyCode | null>(null);
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCurrencyState(getPreferredCurrency());
  }, []);

  useEffect(() => {
    if (!currency) {
      setRate(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchXlmExchangeRate(currency)
      .then((r) => {
        if (!cancelled) setRate(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to fetch exchange rate');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currency]);

  const setCurrency = useCallback((code: CurrencyCode | null) => {
    setPreferredCurrency(code);
    setCurrencyState(code);
  }, []);

  return { currency, setCurrency, rate, loading, error };
}
