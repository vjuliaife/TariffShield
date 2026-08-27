'use client';

import { useEffect, useState } from 'react';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted mt-1">{hint}</p> : null}
    </div>
  );
}

function UtilizationGauge({ utilization }: { utilization: number }) {
  const color = utilization >= 100 ? 'var(--danger)' : utilization >= 80 ? 'var(--accent)' : 'var(--success)';
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">Utilization</p>
      <div className="mt-3 h-3 w-full rounded-full bg-background border border-border overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(utilization, 100)}%`, background: color }}
        />
      </div>
      <p className="mt-2 text-sm font-semibold" style={{ color }}>
        {utilization.toFixed(1)}%
      </p>
    </div>
  );
}

export function DemoDashboard() {
  const demoData = [
    { collateral: '120.5K XLM', required: '100.0K XLM', utilization: 82, reserve: '45.2K XLM' },
    { collateral: '118.3K XLM', required: '105.0K XLM', utilization: 88, reserve: '42.1K XLM' },
    { collateral: '125.0K XLM', required: '100.0K XLM', utilization: 75, reserve: '48.0K XLM' },
    { collateral: '130.2K XLM', required: '110.0K XLM', utilization: 92, reserve: '40.5K XLM' },
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((p) => (p + 1) % demoData.length), 3000);
    return () => clearInterval(id);
  }, []);
  const current = demoData[idx]!;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Stat label="Posted Collateral" value={current.collateral} hint="Simulated SSE stream" />
      <Stat label="Required Collateral" value={current.required} />
      <Stat label="Reserve Pool" value={current.reserve} />
      <div className="sm:col-span-3">
        <UtilizationGauge utilization={current.utilization} />
      </div>
    </div>
  );
}

export default DemoDashboard;
