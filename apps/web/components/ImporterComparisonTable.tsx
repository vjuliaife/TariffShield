'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { stroopsToXlm } from '@/lib/api';

export interface ImporterRow {
  id: string;
  legalName: string;
  ein: string | null;
  bondId: string;
  requiredCollateral: string;
  postedCollateral: string;
  utilization: number;
  reserve: string;
  yieldAccrued: string;
  healthScore?: number;
  lastActivity?: string;
  stellarAddress?: string;
}

interface ImporterComparisonTableProps {
  importers: ImporterRow[];
}

type SortKey = keyof ImporterRow;
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey; label: string; defaultVisible: boolean }[] = [
  { key: 'legalName', label: 'Importer Name', defaultVisible: true },
  { key: 'ein', label: 'EIN', defaultVisible: true },
  { key: 'requiredCollateral', label: 'Required Collateral (XLM)', defaultVisible: true },
  { key: 'postedCollateral', label: 'Posted Collateral (XLM)', defaultVisible: true },
  { key: 'utilization', label: 'Utilization (%)', defaultVisible: true },
  { key: 'reserve', label: 'Reserve (XLM)', defaultVisible: true },
  { key: 'yieldAccrued', label: 'Yield Accrued (XLM)', defaultVisible: true },
  { key: 'healthScore', label: 'Health Score', defaultVisible: true },
  { key: 'lastActivity', label: 'Last Activity', defaultVisible: true },
];

function formatXlm(stroops: string): string {
  const xlm = stroopsToXlm(stroops);
  const num = parseFloat(xlm);
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K XLM`;
  }
  return `${xlm} XLM`;
}

function utilizationColor(util: number): string {
  if (util >= 100) return 'var(--danger)';
  if (util >= 80) return 'var(--accent)';
  return 'var(--success)';
}

export function ImporterComparisonTable({ importers }: ImporterComparisonTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortParam = searchParams.get('sort') as SortKey | null;
  const dirParam = searchParams.get('dir') as SortDir | null;

  const [sortKey, setSortKey] = useState<SortKey>(sortParam || 'utilization');
  const [sortDir, setSortDir] = useState<SortDir>(dirParam || 'desc');
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('ts_surety_columns');
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as string[];
          return new Set(parsed);
        } catch {}
      }
    }
    return new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));
  });
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    localStorage.setItem('ts_surety_columns', JSON.stringify([...visibleColumns]));
  }, [visibleColumns]);

  useEffect(() => {
    if (sortParam) setSortKey(sortParam);
    if (dirParam) setSortDir(dirParam);
  }, [sortParam, dirParam]);

  function handleSort(key: SortKey) {
    let newDir: SortDir = 'asc';
    if (sortKey === key) {
      newDir = sortDir === 'asc' ? 'desc' : 'asc';
    }
    setSortKey(key);
    setSortDir(newDir);
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', key);
    params.set('dir', newDir);
    router.push(`?${params.toString()}`);
  }

  function toggleColumn(key: string) {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const sorted = useMemo(() => {
    return [...importers].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      // numeric string comparison for XLM fields
      if (typeof av === 'string' && typeof bv === 'string' && !isNaN(Number(av)) && !isNaN(Number(bv))) {
        const diff = BigInt(av) > BigInt(bv) ? 1 : BigInt(av) < BigInt(bv) ? -1 : 0;
        return sortDir === 'asc' ? diff : -diff;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [importers, sortKey, sortDir]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <div className="relative">
          <button
            type="button"
            aria-label="Toggle column visibility"
            onClick={() => setShowColumnPicker(!showColumnPicker)}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-background flex items-center gap-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2m0 18v2m11-11h-2M3 12H1m18.364-7.364-1.414 1.414M4.05 19.95l-1.414 1.414M19.95 19.95l-1.414-1.414M4.05 4.05 5.464 5.464" />
            </svg>
            Columns
          </button>
          {showColumnPicker ? (
            <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border border-border bg-card p-3 shadow-lg">
              <p className="text-xs font-semibold text-muted mb-2">Visible Columns</p>
              {COLUMNS.map((col) => (
                <label key={col.key} className="flex items-center gap-2 py-1 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleColumns.has(col.key)}
                    onChange={() => toggleColumn(col.key)}
                    className="rounded border-border"
                  />
                  {col.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-card">
              {COLUMNS.filter((c) => visibleColumns.has(c.key)).map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  tabIndex={0}
                  role="button"
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => handleSort(col.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSort(col.key);
                    }
                  }}
                  className="whitespace-nowrap px-4 py-3 text-xs uppercase tracking-wide text-muted cursor-pointer hover:text-foreground select-none"
                >
                  {col.label} {sortKey === col.key ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((imp) => (
              <tr
                key={imp.id}
                tabIndex={0}
                role="button"
                aria-label={`View importer ${imp.legalName}`}
                onClick={() => router.push(`/surety/${imp.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') router.push(`/surety/${imp.id}`);
                }}
                className="border-b border-border hover:bg-background cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {visibleColumns.has('legalName') ? (
                  <td className="px-4 py-3 font-medium">{imp.legalName}</td>
                ) : null}
                {visibleColumns.has('ein') ? (
                  <td className="px-4 py-3 font-mono text-xs">{imp.ein ?? '—'}</td>
                ) : null}
                {visibleColumns.has('requiredCollateral') ? (
                  <td className="px-4 py-3 font-mono text-xs">{formatXlm(imp.requiredCollateral)}</td>
                ) : null}
                {visibleColumns.has('postedCollateral') ? (
                  <td className="px-4 py-3 font-mono text-xs">{formatXlm(imp.postedCollateral)}</td>
                ) : null}
                {visibleColumns.has('utilization') ? (
                  <td className="px-4 py-3 font-semibold" style={{ color: utilizationColor(imp.utilization) }}>
                    {imp.utilization}%
                  </td>
                ) : null}
                {visibleColumns.has('reserve') ? (
                  <td className="px-4 py-3 font-mono text-xs">{formatXlm(imp.reserve)}</td>
                ) : null}
                {visibleColumns.has('yieldAccrued') ? (
                  <td className="px-4 py-3 font-mono text-xs">{formatXlm(imp.yieldAccrued)}</td>
                ) : null}
                {visibleColumns.has('healthScore') ? (
                  <td className="px-4 py-3">{imp.healthScore ?? '—'}</td>
                ) : null}
                {visibleColumns.has('lastActivity') ? (
                  <td className="px-4 py-3 text-xs text-muted">{imp.lastActivity ? new Date(imp.lastActivity).toLocaleDateString() : '—'}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default ImporterComparisonTable;
