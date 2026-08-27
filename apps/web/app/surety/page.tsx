'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { api, ApiError, type Importer, type ImporterMetrics, stroopsToXlm } from '@/lib/api';
import { ImporterComparisonTable, type ImporterRow } from '@/components/ImporterComparisonTable';
import { getUser, isAuthenticated } from '@/lib/auth';

export default function SuretyDashboard() {
  const router = useRouter();
  const [importers, setImporters] = useState<Importer[] | null>(null);
  const [metrics, setMetrics] = useState<ImporterMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }
    const user = getUser();
    if (user?.role !== 'surety_admin') {
      router.replace('/app');
      return;
    }
    refresh();
  }, [router]);

  async function refresh() {
    try {
      const r = await api.listImporters();
      setImporters(r.importers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
    // #251: served from importer_metrics_mv — failures here shouldn't block
    // the (more important) importer list from rendering.
    try {
      const s = await api.getStats();
      setMetrics(s.metrics);
    } catch (e) {
      console.error('failed to load dashboard stats', e);
    }
  }

  return (
    <>
      <Nav />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Surety portfolio</h1>
        <p className="mt-1 text-sm text-muted">
          Bonded importers + emergency clawback. All actions execute on Stellar testnet.
        </p>

        {metrics ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-4">
            <MetricTile label="Total importers" value={String(metrics.totalImporters)} />
            <MetricTile
              label="Total bond value"
              value={`${stroopsToXlm(metrics.totalBondValue)} XLM`}
            />
            <MetricTile label="Avg. balance" value={`${stroopsToXlm(metrics.avgBalance)} XLM`} />
            <MetricTile label="Compliance rate" value={`${metrics.complianceRate}%`} />
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-8">
          {importers === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : importers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted">No bonded importers yet.</p>
              <p className="mt-2 text-xs text-muted">
                Importers register themselves via the importer dashboard. Share signup link with
                your book.
              </p>
            </div>
          ) : (
            <ImporterComparisonTable
              importers={importers.map((imp) => ({
                id: imp.id,
                legalName: imp.legalName,
                ein: imp.ein,
                bondId: imp.bondId,
                requiredCollateral: '0',
                postedCollateral: '0',
                utilization: 0,
                reserve: '0',
                yieldAccrued: '0',
                healthScore: 100,
                lastActivity: imp.createdAt,
                stellarAddress: imp.stellarAddress,
              } as ImporterRow))}
            />
          )}
        </div>
      </main>
    </>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  );
}
