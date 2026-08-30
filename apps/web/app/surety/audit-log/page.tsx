'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { api, type AuditLogEntry } from '@/lib/api';
import { getUser, isAuthenticated } from '@/lib/auth';

function AuditLogContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search & Filter state initialized from URL params
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [action, setAction] = useState(searchParams.get('action') || '');
  const [actorUserId, setActorUserId] = useState(searchParams.get('actor_user_id') || '');
  const [fromDate, setFromDate] = useState(
    searchParams.get('from') ? searchParams.get('from')!.slice(0, 10) : ''
  );
  const [toDate, setToDate] = useState(
    searchParams.get('to') ? searchParams.get('to')!.slice(0, 10) : ''
  );
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const perPage = 25;

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const syncUrlParams = useCallback(
    (newParams: Record<string, string | number | undefined>) => {
      const sp = new URLSearchParams();
      if (newParams.search) sp.set('search', String(newParams.search));
      if (newParams.action) sp.set('action', String(newParams.action));
      if (newParams.actor_user_id) sp.set('actor_user_id', String(newParams.actor_user_id));
      if (newParams.from) sp.set('from', String(newParams.from));
      if (newParams.to) sp.set('to', String(newParams.to));
      if (newParams.page && Number(newParams.page) > 1) sp.set('page', String(newParams.page));
      router.replace(`/surety/audit-log?${sp.toString()}`);
    },
    [router]
  );

  const fetchAuditLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fromIso = fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined;
      const toIso = toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined;

      const res = await api.getAuditLog({
        search: search.trim() || undefined,
        action: action.trim() || undefined,
        actor_user_id: actorUserId.trim() || undefined,
        from: fromIso,
        to: toIso,
        page,
        per_page: perPage,
      });

      setEntries(res.data);
      setTotal(res.pagination.total);
      setTotalPages(res.pagination.total_pages);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, [search, action, actorUserId, fromDate, toDate, page]);

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
    fetchAuditLogs();
  }, [router, fetchAuditLogs]);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    const fromIso = fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined;
    const toIso = toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined;

    syncUrlParams({
      search: search.trim() || undefined,
      action: action.trim() || undefined,
      actor_user_id: actorUserId.trim() || undefined,
      from: fromIso,
      to: toIso,
      page: 1,
    });
  };

  const handleResetFilters = () => {
    setSearch('');
    setAction('');
    setActorUserId('');
    setFromDate('');
    setToDate('');
    setPage(1);
    router.replace('/surety/audit-log');
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    const fromIso = fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined;
    const toIso = toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined;

    syncUrlParams({
      search: search.trim() || undefined,
      action: action.trim() || undefined,
      actor_user_id: actorUserId.trim() || undefined,
      from: fromIso,
      to: toIso,
      page: newPage,
    });
  };

  const handleExportCsv = () => {
    const fromIso = fromDate ? new Date(`${fromDate}T00:00:00.000Z`).toISOString() : undefined;
    const toIso = toDate ? new Date(`${toDate}T23:59:59.999Z`).toISOString() : undefined;

    const csvUrl = api.getAuditLogCsvUrl({
      search: search.trim() || undefined,
      action: action.trim() || undefined,
      actor_user_id: actorUserId.trim() || undefined,
      from: fromIso,
      to: toIso,
    });

    window.open(csvUrl, '_blank');
  };

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Link href="/surety" className="text-xs text-muted hover:text-foreground">
                &larr; Back to Portfolio
              </Link>
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">Surety Admin Audit Log</h1>
            <p className="mt-1 text-sm text-muted">
              Searchable, filterable audit trail for collateral changes, compliance decisions, and
              dual sign-offs.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground hover:bg-accent/90"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export to CSV
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <form
          onSubmit={handleFilterSubmit}
          className="mt-6 rounded-lg border border-border bg-card p-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5 items-end"
        >
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-muted mb-1">Search Keywords</label>
            <input
              type="text"
              placeholder="Search description, email, target ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">Action Type</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">All Actions</option>
              <option value="withdraw">withdraw</option>
              <option value="withdraw_requested_pending_approval">withdraw_requested</option>
              <option value="withdraw_approved">withdraw_approved</option>
              <option value="withdraw_rejected">withdraw_rejected</option>
              <option value="withdraw_cancelled">withdraw_cancelled</option>
              <option value="deposit">deposit</option>
              <option value="accrue_yield">accrue_yield</option>
              <option value="clawback">clawback</option>
              <option value="kyc_status_update">kyc_status_update</option>
              <option value="dual_approval_configured">dual_approval_configured</option>
              <option value="sku_mappings_imported">sku_mappings_imported</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="flex gap-2 sm:col-span-2 lg:col-span-5 justify-end">
            <button
              type="button"
              onClick={handleResetFilters}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted hover:bg-accent/10 hover:text-foreground"
            >
              Reset
            </button>
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Apply Filters
            </button>
          </div>
        </form>

        {/* Results Summary */}
        <div className="mt-4 flex items-center justify-between text-xs text-muted">
          <span>
            Showing {entries.length} of {total} audit entries
          </span>
          {totalPages > 1 && (
            <span>
              Page {page} of {totalPages}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="mt-4 rounded-lg border border-border bg-card overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-sm text-muted animate-pulse">
              Loading audit logs...
            </div>
          ) : entries.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-sm font-medium">No audit entries found</p>
              <p className="mt-1 text-xs text-muted">
                Try broadening your search or resetting active filters.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/30 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Timestamp</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <th className="px-4 py-3 font-medium">Target ID</th>
                    <th className="px-4 py-3 font-medium text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((entry) => {
                    const isExpanded = expandedId === entry.id;
                    return (
                      <tr key={entry.id} className="hover:bg-muted/10 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">
                          {new Date(entry.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                              entry.action.includes('withdraw')
                                ? 'bg-yellow-500/10 text-yellow-600'
                                : entry.action.includes('approved') ||
                                    entry.action.includes('deposit')
                                  ? 'bg-success/10 text-success'
                                  : entry.action.includes('rejected') ||
                                      entry.action.includes('clawback')
                                    ? 'bg-danger/10 text-danger'
                                    : 'bg-muted text-foreground'
                            }`}
                          >
                            {entry.action}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {entry.actor_email ? (
                            <span className="font-mono">{entry.actor_email}</span>
                          ) : entry.actor_user_id ? (
                            <span className="font-mono text-muted">
                              {entry.actor_user_id.slice(0, 8)}...
                            </span>
                          ) : (
                            <span className="text-muted">system</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted">
                          {entry.target_id ? `${entry.target_id.slice(0, 8)}...` : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {entry.payload && Object.keys(entry.payload).length > 0 ? (
                            <button
                              onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                              className="text-xs text-accent hover:underline font-mono"
                            >
                              {isExpanded ? 'Hide' : 'View payload'}
                            </button>
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Expanded Payload Viewer */}
        {expandedId && (
          <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold">Payload details for {expandedId}</span>
              <button
                onClick={() => setExpandedId(null)}
                className="text-xs text-muted hover:text-foreground"
              >
                Close &times;
              </button>
            </div>
            <pre className="text-xs font-mono bg-background p-3 rounded border border-border overflow-x-auto">
              {JSON.stringify(entries.find((e) => e.id === expandedId)?.payload, null, 2)}
            </pre>
          </div>
        )}

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div className="mt-6 flex items-center justify-between">
            <button
              onClick={() => handlePageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50 hover:bg-muted/20"
            >
              &larr; Previous
            </button>
            <div className="text-xs text-muted">
              Page {page} of {totalPages}
            </div>
            <button
              onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50 hover:bg-muted/20"
            >
              Next &rarr;
            </button>
          </div>
        )}
      </main>
    </>
  );
}

export default function SuretyAuditLogPage() {
  return (
    <Suspense
      fallback={
        <div className="p-12 text-center text-sm text-muted">Loading audit log view...</div>
      }
    >
      <AuditLogContent />
    </Suspense>
  );
}
