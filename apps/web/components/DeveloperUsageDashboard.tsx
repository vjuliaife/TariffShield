'use client';

import { useEffect, useState } from 'react';
import { api, type ApiKeyUsageSummary, type DeveloperKey } from '@/lib/api';
import { formatApiError } from '@/lib/error-formatter';

/**
 * Issue #1043 — Developer dashboard: recent API-call volume, per-category
 * breakdown, and how close the caller is to any configured per-minute limit.
 */
export function DeveloperUsageDashboard() {
  const [usage, setUsage] = useState<ApiKeyUsageSummary | null>(null);
  const [keys, setKeys] = useState<DeveloperKey[]>([]);
  const [keyCount, setKeyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [u, k] = await Promise.all([api.developerUsage(), api.developerKeys()]);
        if (cancelled) return;
        setUsage(u.usage);
        setKeyCount(u.keyCount);
        setKeys(k.keys);
      } catch (e) {
        if (!cancelled) setError(formatApiError(e).userMessage);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (loading) return <p className="text-sm text-muted">Loading usage…</p>;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!usage) return null;

  const total24h = usage.last24hByHour.reduce((s, b) => s + b.requestCount, 0);
  const total30d = usage.last30dByDay.reduce((s, b) => s + b.requestCount, 0);

  return (
    <div className="space-y-5">
      {keyCount === 0 && (
        <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted">
          No active API keys. Create a key to start collecting usage data.
        </div>
      )}

      {usage.approachingLimit && usage.rateLimitPerMin != null && (
        <div className="rounded-lg border border-danger bg-danger/10 p-3 text-sm">
          <p className="font-semibold text-danger">Approaching rate limit</p>
          <p className="mt-1 text-xs text-muted">
            {usage.currentMinuteCount} / {usage.rateLimitPerMin} requests this minute (
            {Math.round((usage.currentMinuteCount / usage.rateLimitPerMin) * 100)}%).
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Requests (24h)" value={total24h.toLocaleString()} />
        <Stat label="Requests (30d)" value={total30d.toLocaleString()} />
        <Stat
          label="This minute"
          value={
            usage.rateLimitPerMin != null
              ? `${usage.currentMinuteCount} / ${usage.rateLimitPerMin}`
              : String(usage.currentMinuteCount)
          }
        />
      </div>

      {usage.rateLimitPerMin != null && (
        <div>
          <p className="mb-1 text-xs text-muted">
            Remaining quota this minute: {usage.remaining ?? 0} / {usage.rateLimitPerMin}
          </p>
          <QuotaBar used={usage.currentMinuteCount} limit={usage.rateLimitPerMin} />
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold text-muted">Requests per hour (last 24h)</p>
        <BarChart buckets={usage.last24hByHour} />
      </div>

      {usage.last24hByCategory.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted">By endpoint category (24h)</p>
          <ul className="space-y-1 text-sm">
            {usage.last24hByCategory.map((c) => (
              <li key={c.category} className="flex justify-between">
                <span className="text-muted">{c.category}</span>
                <span className="font-mono">{c.requestCount.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {keys.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted">Keys</p>
          <ul className="space-y-1 text-xs">
            {keys.map((k) => (
              <li key={k.id} className="flex justify-between font-mono">
                <span>
                  {k.prefix}… {k.label ? `(${k.label})` : ''}
                  {k.revoked_at ? ' — revoked' : ''}
                </span>
                <span className="text-muted">
                  {k.rate_limit_per_min != null ? `${k.rate_limit_per_min}/min` : 'no limit'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const color = pct >= 80 ? 'bg-danger' : 'bg-success';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-border">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function BarChart({ buckets }: { buckets: { windowStart: string; requestCount: number }[] }) {
  if (buckets.length === 0) {
    return <p className="text-xs text-muted">No requests in this window.</p>;
  }
  const width = 480;
  const height = 120;
  const max = Math.max(1, ...buckets.map((b) => b.requestCount));
  const barW = width / Math.max(buckets.length, 1);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="API requests per hour over the last 24 hours"
      >
        {buckets.map((b, i) => {
          const h = (b.requestCount / max) * (height - 16);
          return (
            <rect
              key={b.windowStart}
              x={i * barW + 1}
              y={height - h}
              width={Math.max(barW - 2, 1)}
              height={h}
              className="fill-accent"
            >
              <title>
                {new Date(b.windowStart).toLocaleString()}: {b.requestCount}
              </title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
