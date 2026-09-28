'use client';

import { useEffect, useState } from 'react';

type HistoryPoint = {
  date: string;
  dutyRate: number;
  source: string;
};

export function TariffRateChart({
  importerId,
  initialHtsCode = '8703.23.0100',
}: {
  importerId: string;
  initialHtsCode?: string;
}) {
  const [htsCode, setHtsCode] = useState(initialHtsCode);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [latestUploadDate, setLatestUploadDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetchHistory = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/importers/${importerId}/tariff-history?htsCode=${encodeURIComponent(htsCode)}`
        );
        if (!res.ok) throw new Error('Failed to load tariff history');
        const data = await res.json();
        if (isMounted) {
          setHistory(data.history || []);
          setLatestUploadDate(data.latestUploadDate || null);
        }
      } catch {
        if (isMounted) {
          setError('Could not load historical rate data.');
          setHistory([]);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchHistory();
    return () => {
      isMounted = false;
    };
  }, [importerId, htsCode]);

  const maxRate = Math.max(...history.map((h) => h.dutyRate), 0.1);
  const minRate = Math.min(...history.map((h) => h.dutyRate), 0);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-foreground">Historical Tariff Rate Trend</h3>
          <p className="text-xs text-muted">Read-only historical duty rate movement per HTS code</p>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted">HTS Code:</label>
          <input
            type="text"
            value={htsCode}
            onChange={(e) => setHtsCode(e.target.value)}
            className="text-xs font-mono px-2 py-1 rounded border border-border bg-background w-32"
          />
        </div>
      </div>

      {latestUploadDate && (
        <div className="text-[11px] text-accent font-medium bg-accent/10 p-2 rounded border border-accent/20">
          📍 Most Recent CSV Upload: {new Date(latestUploadDate).toLocaleDateString()}
        </div>
      )}

      {loading ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted">
          Loading rate history chart...
        </div>
      ) : error ? (
        <div className="h-40 flex items-center justify-center text-xs text-danger">
          {error}
        </div>
      ) : history.length === 0 ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted italic">
          No historical tariff rate points recorded for HTS code {htsCode}.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative h-44 w-full border-b border-l border-border/60 flex items-end justify-between px-4 pt-6 pb-2 gap-2">
            {history.map((point, idx) => {
              const heightPercent =
                maxRate === minRate
                  ? 50
                  : Math.max(10, Math.round(((point.dutyRate - minRate) / (maxRate - minRate)) * 100));

              return (
                <div key={idx} className="flex-1 flex flex-col items-center group relative">
                  {/* Tooltip */}
                  <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity bg-background border border-border text-[10px] p-1 rounded shadow whitespace-nowrap z-10">
                    {(point.dutyRate * 100).toFixed(2)}% ({point.date})
                  </div>

                  {/* Bar/Point */}
                  <div
                    className="w-full max-w-[24px] bg-accent/80 hover:bg-accent rounded-t transition-all"
                    style={{ height: `${heightPercent}%` }}
                  />
                  <span className="text-[9px] text-muted truncate max-w-[40px] mt-1 font-mono">
                    {point.date.slice(5)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between text-[10px] text-muted pt-1">
            <span>Range: {(minRate * 100).toFixed(2)}% – {(maxRate * 100).toFixed(2)}%</span>
            <span>Total Points: {history.length}</span>
          </div>
        </div>
      )}
    </div>
  );
}
