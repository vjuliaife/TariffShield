'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { api, ApiError, type Importer, type ImporterMetrics, stroopsToXlm } from '@/lib/api';
import { getUser, isAuthenticated } from '@/lib/auth';

export default function SuretyDashboard() {
  const router = useRouter();
  const [importers, setImporters] = useState<Importer[] | null>(null);
  const [metrics, setMetrics] = useState<ImporterMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState(false);
  const [signupUrl, setSignupUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setSignupUrl(`${window.location.origin}/signup`);
    }
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(signupUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy signup link', err);
    }
  };

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
      setMetricsError(false);
    } catch (e) {
      console.error('failed to load dashboard stats', e);
      setMetricsError(true);
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

        {importers === null ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-4 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4">
                <div className="h-3 w-20 rounded bg-border" />
                <div className="mt-2 h-6 w-24 rounded bg-border" />
              </div>
            ))}
          </div>
        ) : metrics ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-4">
            <MetricTile label="Total importers" value={String(metrics.totalImporters)} />
            <MetricTile
              label="Total bond value"
              value={`${stroopsToXlm(metrics.totalBondValue)} XLM`}
            />
            <MetricTile label="Avg. balance" value={`${stroopsToXlm(metrics.avgBalance)} XLM`} />
            <MetricTile label="Compliance rate" value={`${metrics.complianceRate}%`} />
          </div>
        ) : metricsError ? (
          <p className="mt-6 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            Metrics unavailable. Portfolio totals couldn&apos;t be loaded — the importer list below
            is unaffected.
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-8">
          {importers === null ? (
            <div className="divide-y divide-border rounded-lg border border-border bg-card animate-pulse">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-4 px-4 py-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-4 w-40 rounded bg-border" />
                    <div className="h-3 w-56 rounded bg-border" />
                    <div className="h-3 w-72 rounded bg-border" />
                  </div>
                  <div className="h-4 w-12 rounded bg-border" />
                </div>
              ))}
            </div>
          ) : importers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted">No bonded importers yet.</p>
              <p className="mt-2 text-xs text-muted">
                Importers register themselves via the importer dashboard. Share signup link with
                your book.
              </p>
              {signupUrl && (
                <div className="mt-4 flex items-center justify-center gap-2 max-w-md mx-auto rounded-md border border-border bg-card p-2 text-xs">
                  <span className="truncate font-mono text-muted select-all">{signupUrl}</span>
                  <button
                    onClick={handleCopy}
                    className="shrink-0 rounded bg-accent px-2.5 py-1.5 text-accent-foreground font-semibold hover:opacity-90 transition-opacity"
                  >
                    {copied ? 'Copied!' : 'Copy link'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {importers.map((imp) => (
                <li key={imp.id}>
                  <Link
                    href={`/surety/${imp.id}`}
                    onMouseEnter={() => api.prefetchImporter(imp.id)}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-background"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{imp.legalName}</p>
                      <p className="text-xs text-muted">
                        Bond <span className="font-mono">{imp.bondId}</span> · {imp.email}
                      </p>
                      <p className="text-xs text-muted font-mono break-all">{imp.stellarAddress}</p>
                    </div>
                    <span className="text-xs text-accent">manage →</span>
                  </Link>
                </li>
              ))}
            </ul>
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
