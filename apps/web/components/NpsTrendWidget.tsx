'use client';

import { useEffect, useState } from 'react';
import { api, type NpsTrendPoint } from '@/lib/api';

// Issue #1035 — admin-facing aggregate NPS trend (weekly buckets, server-computed).
export function NpsTrendWidget() {
  const [trend, setTrend] = useState<NpsTrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .npsAdminTrend()
      .then((r) => setTrend(r.trend))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load NPS trend'));
  }, []);

  const latest = trend && trend.length > 0 ? trend[trend.length - 1]! : null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Importer NPS trend (26 weeks)</h3>
      {error ? (
        <p className="mt-2 text-xs text-danger">{error}</p>
      ) : trend === null ? (
        <p className="mt-2 text-xs text-muted">Loading…</p>
      ) : trend.length === 0 ? (
        <p className="mt-2 text-xs text-muted">No survey responses yet.</p>
      ) : (
        <>
          <p className="mt-1 text-3xl font-bold tabular-nums">{latest?.nps}</p>
          <p className="text-xs text-muted">
            Current NPS · {latest?.total} response{latest?.total === 1 ? '' : 's'} this week
          </p>
          <div className="mt-3 flex items-end gap-1 h-16">
            {trend.map((point) => {
              const heightPct = Math.max(4, ((point.nps + 100) / 200) * 100);
              return (
                <div
                  key={point.weekStart}
                  title={`Week of ${point.weekStart}: NPS ${point.nps} (${point.total} responses)`}
                  className="flex-1 bg-accent/70 rounded-t"
                  style={{ height: `${heightPct}%` }}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
