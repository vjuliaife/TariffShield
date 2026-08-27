'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { ErrorBanner } from '@/components/ErrorBanner';
import { api, type ImporterDetail, type ContractEvent, stroopsToXlm } from '@/lib/api';
import { getUser, isAuthenticated } from '@/lib/auth';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';
import { getEventAmountLabel } from '@/lib/event-helpers';

export default function SuretyImporterDetail() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<ImporterDetail | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [error, setError] = useState<FormattedError | string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [yieldXlm, setYieldXlm] = useState('1');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Clear success message automatically after 5 seconds
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => {
      setSuccessMessage(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  const refresh = useCallback(async () => {
    if (!params?.id) return;
    try {
      const d = await api.getImporter(params.id);
      setDetail(d);
      // #255: events are no longer inlined into getImporter() — fetch the
      // first page from the cursor-paginated endpoint instead.
      const page = await api.getImporterEventsCursor(params.id);
      setEvents(page.data);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, [params?.id]);

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
  }, [router, refresh]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    setSuccessMessage(null);
    try {
      await fn();
      await refresh();
      if (name === 'yield') {
        setSuccessMessage(`Simulated yield of ${yieldXlm} XLM successfully accrued.`);
      } else if (name === 'clawback') {
        setSuccessMessage(
          'Emergency clawback successfully executed. Importer account has been frozen.'
        );
      }
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!detail)
    return (
      <>
        <Nav />
        <main className="max-w-4xl mx-auto px-6 py-10">
          <p className="text-muted">Loading…</p>
        </main>
      </>
    );

  const onc = detail.onChainAccount;
  const totalAtRisk = BigInt(onc.collateralBalance) + BigInt(onc.reserveBalance);

  return (
    <>
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <Link
          href="/surety"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-card text-xs font-medium text-muted hover:text-accent hover:border-accent/40 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-3.5 h-3.5"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          Back to portfolio
        </Link>

        <div className="mt-4">
          <h1 className="text-2xl font-semibold">{detail.importer.legalName}</h1>
          <p className="mt-1 text-sm text-muted">
            Bond <span className="font-mono">{detail.importer.bondId}</span>
          </p>
          <p className="mt-1 text-xs font-mono break-all text-muted">
            {detail.importer.stellarAddress}
          </p>
        </div>

        {onc.isClawbacked ? (
          <div className="mt-6 rounded-lg border border-danger bg-danger/10 px-4 py-3 text-sm">
            <strong className="text-danger">Account frozen.</strong> Clawback already executed.
            Contact the importer and review the on-chain event log below before taking further
            admin action.
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Collateral</p>
            <p className="mt-1 text-xl font-semibold font-mono">
              {stroopsToXlm(onc.collateralBalance)} XLM
            </p>
            <p className="mt-1 text-xs text-muted">
              Required: <span className="font-mono">{stroopsToXlm(onc.requiredCollateral)}</span>
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Reserve (auto-top-up pool)</p>
            <p className="mt-1 text-xl font-semibold font-mono">
              {stroopsToXlm(onc.reserveBalance)} XLM
            </p>
            <p className="mt-1 text-xs text-muted">
              Yield accrued: <span className="font-mono">{stroopsToXlm(onc.yieldAccrued)}</span>
            </p>
          </div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Accrue simulated BENJI yield</h2>
            <p className="mt-1 text-xs text-muted">
              Records yield on-chain. Mainnet wires this to real T-bill fund flow.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={yieldXlm}
                onChange={(e) => setYieldXlm(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
              />
              <button
                disabled={busy !== null || onc.isClawbacked}
                onClick={() =>
                  act('yield', () =>
                    api.accrueYield(detail.importer.id, {
                      amountStroops: BigInt(Math.round(Number(yieldXlm) * 1e7)).toString(),
                    })
                  )
                }
                className="rounded-md border border-accent text-accent px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              >
                {busy === 'yield' ? '…' : 'Accrue'}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
            <h2 className="text-sm font-semibold text-danger">Emergency clawback</h2>
            <p className="mt-1 text-xs text-muted">
              Drains <span className="font-mono">{stroopsToXlm(totalAtRisk.toString())} XLM</span>{' '}
              (collateral + reserve) to surety wallet + freezes account. Use on importer default.
            </p>
            <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-danger">
              <span aria-hidden="true">⚠</span>
              <span>This action cannot be undone.</span>
            </p>
            <button
              disabled={busy !== null || onc.isClawbacked || totalAtRisk === 0n}
              onClick={() => setConfirmClawback(true)}
              className="mt-3 rounded-md bg-danger text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'clawback'
                ? 'Executing clawback on-chain…'
                : onc.isClawbacked
                  ? 'Already clawed back'
                  : totalAtRisk === 0n
                    ? 'No funds to claw back'
                    : 'Clawback now'}
            </button>
          </div>
        </div>

        {successMessage ? (
          <div className="mt-4 flex items-center justify-between rounded border border-success bg-success/10 px-3 py-2 text-sm text-success transition-all duration-300">
            <div className="flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5 flex-shrink-0"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
                  clipRule="evenodd"
                />
              </svg>
              <span>{successMessage}</span>
            </div>
            <button
              onClick={() => setSuccessMessage(null)}
              className="text-success hover:opacity-85 text-xs font-semibold focus:outline-none"
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <ErrorBanner error={error} className="mt-4" />

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            On-chain event log
          </h2>
          {events.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No events.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
              {events.map((e) => (
                <li key={e.id} className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{e.kind}</p>
                    <p className="text-xs text-muted">{new Date(e.createdAt).toLocaleString()}</p>
                  </div>
                  <span className="text-sm font-mono">{getEventAmountLabel(e)}</span>
                  {e.txUrl ? (
                    <a
                      href={e.txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent hover:underline font-mono"
                    >
                      {e.txHash.slice(0, 8)}…
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
