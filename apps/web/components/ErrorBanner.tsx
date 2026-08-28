'use client';

import { useState } from 'react';
import { formatApiError, type ErrorSeverity, type FormattedError } from '@/lib/error-formatter';

/**
 * Error banner severity tiers — see the `ErrorSeverity` doc comment in
 * lib/error-formatter.ts for the full convention. In short:
 *   - 'warning': the user can plausibly fix this and retry (validation,
 *     insufficient balance, temporary locks, rate limiting).
 *   - 'danger': a hard rejection or failure (compliance/business-rule
 *     rejections, state conflicts, technical/network failures).
 *
 * `severity` is optional and only needed to override the tier that
 * `formatApiError` already infers from the error content — most callers
 * (deposit, withdraw, registration, tariff updates) don't need to pass it.
 * Use the override for banners that aren't wrapping an API error at all,
 * e.g. a hardcoded "account frozen by clawback" notice that should always
 * render as 'danger' regardless of how it's triggered.
 */
const TIER_STYLES: Record<ErrorSeverity, { container: string; detailsButton: string }> = {
  warning: {
    container: 'border-warning/30 bg-warning/10 text-warning',
    detailsButton: 'text-warning/80 hover:text-warning',
  },
  danger: {
    container: 'border-danger/30 bg-danger/10 text-danger',
    detailsButton: 'text-danger/80 hover:text-danger',
  },
};

export function ErrorBanner({
  error,
  className = '',
  severity,
}: {
  error: unknown;
  className?: string;
  /** Override the severity tier instead of inferring it from `error`. */
  severity?: ErrorSeverity;
}) {
  const [showDetails, setShowDetails] = useState(false);

  if (!error) return null;

  const formatted: FormattedError =
    typeof error === 'object' && error !== null && 'userMessage' in error && 'rawMessage' in error
      ? (error as FormattedError)
      : formatApiError(error);

  const tier = TIER_STYLES[severity ?? formatted.severity];

  return (
    <div className={`rounded-md border p-3 text-sm ${tier.container} ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium flex-1">{formatted.userMessage}</p>
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className={`text-xs underline shrink-0 font-mono ${tier.detailsButton}`}
        >
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      </div>
      {showDetails && (
        <div className="mt-2 rounded bg-background/80 p-2 font-mono text-xs text-muted border border-border overflow-x-auto">
          <p className="font-semibold text-foreground mb-1">Technical detail:</p>
          <p className="break-all">{formatted.rawMessage}</p>
        </div>
      )}
    </div>
  );
}
