'use client';

// #256: this page stays a Client Component rather than converting to an
// async Server Component. Authentication here is a pure client-side
// mechanism — the JWT lives in localStorage only (see lib/auth.ts), never
// in a cookie — so a Server Component running at request time on the server
// has no way to read the current user's token and would not be able to
// perform the authenticated fetch the SSR conversion depends on. Doing this
// correctly requires migrating auth to (httpOnly) cookies first, which
// touches login/signup and every authenticated fetch call across the app —
// a materially larger, security-sensitive change beyond this issue's
// stated scope, so it isn't attempted here rather than shipping a Server
// Component wrapper that can't actually authenticate.
//
// What *is* implemented from this issue: loading.tsx (a route-level
// Suspense boundary Next.js wraps this page in automatically) streams an
// immediate skeleton as the initial HTML response, improving perceived
// TTI without requiring server-side auth.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Nav } from '@/components/Nav';
import { HealthScore } from '@/components/HealthScore';
import { DepositWizard } from '@/components/DepositWizard';
import { BondTimeline } from '@/components/BondTimeline';
import { ComplianceExpirationCalendar } from '@/components/ComplianceExpirationCalendar';
import { DashboardSkeleton } from '@/components/DashboardSkeleton';
import { Spinner } from '@/components/Spinner';
import { ErrorBanner } from '@/components/ErrorBanner';
import { CurrencyDisplaySettings } from '@/components/CurrencyDisplaySettings';
import { NpsSurvey } from '@/components/NpsSurvey';
import { useDisplayCurrency } from '@/lib/useDisplayCurrency';
import { formatConverted } from '@/lib/currency';
import {
  api,
  type Importer,
  type ImporterDetail,
  type ContractEvent,
  stroopsToXlm,
  formatUsd,
} from '@/lib/api';
import { getUser, isAuthenticated } from '@/lib/auth';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';
import { getEventAmountLabel } from '@/lib/event-helpers';
import { useYieldProjection } from '@/lib/workers/useYieldProjection';
import type { YieldProjectionResponse } from '@/lib/workers/yieldWorker.types';
import * as Sentry from '@sentry/nextjs';

function ImporterDashboard() {
  const router = useRouter();
  const [importer, setImporter] = useState<Importer | null>(null);
  const [detail, setDetail] = useState<ImporterDetail | null>(null);
  const [error, setError] = useState<FormattedError | string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [refreshCount, setRefreshCount] = useState(0);
  const [showTopUpConfirm, setShowTopUpConfirm] = useState(false);
  const displayCurrency = useDisplayCurrency();

  const refresh = useCallback(async () => {
    try {
      const list = await api.listImporters();
      if (list.importers.length === 0) {
        setImporter(null);
        setDetail(null);
        return;
      }
      const first = list.importers[0]!;
      setImporter(first);
      const d = await api.getImporter(first.id);
      setDetail(d);
      setEvents([]);
      setRefreshCount((prev) => prev + 1);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, []);

  const action = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(formatApiError(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const handleTopUp = useCallback(() => {
    if (!importer) return;
    return action('topup', () => api.autoTopUp(importer.id));
  }, [action, importer]);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }
    const user = getUser();
    if (user?.role !== 'importer') {
      router.replace('/surety');
      return;
    }
    refresh();
  }, [router, refresh]);

  // Derived values recomputed only when the on-chain account snapshot changes,
  // not on every render triggered by unrelated state (busy, error, etc.).
  // Hooks must run unconditionally, so this runs before the `!importer`/
  // `!detail` early returns below and guards its own computation instead.
  const { required, collateral, reserve, shortfall, excess, utilization } = useMemo(() => {
    const oncSnapshot = detail?.onChainAccount;
    if (!oncSnapshot) {
      return {
        required: 0n,
        collateral: 0n,
        reserve: 0n,
        shortfall: 0n,
        excess: 0n,
        utilization: 0,
      };
    }
    const required = BigInt(oncSnapshot.requiredCollateral);
    const collateral = BigInt(oncSnapshot.collateralBalance);
    const reserve = BigInt(oncSnapshot.reserveBalance);
    const shortfall = required > collateral ? required - collateral : 0n;
    const excess = collateral > required ? collateral - required : 0n;
    const utilization = required === 0n ? 0 : Number((collateral * 100n) / required);
    return { required, collateral, reserve, shortfall, excess, utilization };
  }, [detail?.onChainAccount]);

  if (!importer) {
    return (
      <>
        <Nav />
        <RegisterImporter onCreated={refresh} setError={setError} error={error} />
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <Nav />
        <DashboardSkeleton />
      </>
    );
  }

  const onc = detail.onChainAccount;

  return (
    <>
      <Nav />
      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted">Customs Bond</p>
            <h1 className="text-2xl font-semibold tracking-tight">{importer.legalName}</h1>
            <p className="mt-1 text-sm text-muted">
              Bond ID <span className="font-mono">{importer.bondId}</span>
              {importer.ein ? (
                <>
                  {' '}
                  · EIN <span className="font-mono">{importer.ein}</span>
                </>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-muted font-mono break-all">{importer.stellarAddress}</p>
          </div>
          {detail.importer.registeredOnChainTx ? (
            <a
              className="text-xs text-accent hover:underline font-mono"
              href={`https://stellar.expert/explorer/testnet/tx/${detail.importer.registeredOnChainTx}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              registration tx ↗
            </a>
          ) : null}
        </div>

        {onc.isClawbacked ? (
          <div className="mt-6 rounded-lg border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
            <strong>Account frozen by surety.</strong> All collateral + reserve has been clawed
            back. No further deposits or withdrawals allowed. Contact your surety support team and
            review the on-chain event log below before taking another action.
          </div>
        ) : null}

        <div className="mt-6">
          <CurrencyDisplaySettings {...displayCurrency} />
        </div>

        <div className="grid gap-4 sm:grid-cols-5 mt-4">
          <div className="sm:col-span-2">
            <HealthScore collateral={collateral} required={required} reserve={reserve} />
          </div>
          <div className="sm:col-span-3">
            <BalanceSummary
              onChainAccount={onc}
              shortfall={shortfall}
              excess={excess}
              utilization={utilization}
              rate={displayCurrency.rate}
            />
          </div>
        </div>

        <YieldProjectionPanel currentBalanceStroops={onc.collateralBalance} />

        {!onc.isClawbacked && (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <ActionCard
              title="Update tariff exposure"
              description="Re-run required collateral from annual duty estimate. Demo computes required = annual_duty × 10% × 50%."
              action={
                <TariffForm
                  importerId={importer.id}
                  currentRequiredStroops={required.toString()}
                  onDone={refresh}
                  setError={setError}
                />
              }
            />
            <ActionCard
              title="Deposit collateral"
              description="Send XLM into the bond escrow bucket. 4-step wizard guides you through the process."
              action={
                <DepositWizard
                  importerId={importer.id}
                  bucket="collateral"
                  onDone={refresh}
                  setError={setError}
                />
              }
            />
            <ActionCard
              title="Deposit reserve"
              description="Top up the auto-top-up pool for tariff spike events. 4-step wizard guides you through the process."
              action={
                <DepositWizard
                  importerId={importer.id}
                  bucket="reserve"
                  onDone={refresh}
                  setError={setError}
                />
              }
            />
          </div>
        )}

        {!onc.isClawbacked && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <button
              onClick={() => setShowTopUpConfirm(true)}
              disabled={busy !== null || shortfall === 0n}
              className="rounded-md bg-accent px-4 py-3 text-accent-foreground hover:opacity-90 disabled:opacity-40 text-sm font-medium"
            >
              {busy === 'topup'
                ? 'Calling auto_top_up on-chain…'
                : shortfall === 0n
                  ? 'auto_top_up (no shortfall)'
                  : `auto_top_up — move ${stroopsToXlm(shortfall.toString())} XLM from reserve`}
            </button>
            {excess > 0n ? (
              <WithdrawCard
                importerId={importer.id}
                maxStroops={excess.toString()}
                onDone={refresh}
                setError={setError}
              />
            ) : (
              <div className="rounded-md border border-border bg-card px-4 py-3 text-xs text-muted flex flex-col justify-center space-y-1">
                <p className="font-semibold text-sm text-foreground">No excess to withdraw</p>
                <p>
                  Your active collateral is at or below the required threshold. This is normal and
                  expected for a compliant bond. To make collateral withdrawable, deposit additional
                  funds exceeding the required balance.
                </p>
              </div>
            )}
          </div>
        )}

        {showTopUpConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl space-y-4">
              <h3 className="text-lg font-semibold tracking-tight">Confirm Auto Top-Up</h3>
              <p className="text-sm text-muted">
                Are you sure you want to execute an on-chain transfer moving collateral shortfall
                from your reserve pool?
              </p>
              <div className="rounded-md border border-border bg-background p-3 text-xs space-y-1.5 font-mono">
                <div className="flex justify-between">
                  <span className="text-muted">Transfer Amount:</span>
                  <span className="font-semibold text-accent">
                    {stroopsToXlm(shortfall.toString())} XLM
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">From:</span>
                  <span>Reserve Pool ({stroopsToXlm(reserve.toString())} XLM)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">To:</span>
                  <span>Collateral Escrow</span>
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTopUpConfirm(false)}
                  className="rounded-md border border-border px-4 py-2 text-sm hover:bg-background font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowTopUpConfirm(false);
                    handleTopUp();
                  }}
                  disabled={busy !== null}
                  className="rounded-md bg-accent px-4 py-2 text-accent-foreground text-sm hover:opacity-90 font-medium"
                >
                  Confirm &amp; Transfer
                </button>
              </div>
            </div>
          </div>
        )}

        <ErrorBanner error={error} className="mt-4" />

        <BondTimeline events={events} importerId={importer.id} userRole="importer" />

        <div className="mt-8">
          <ComplianceExpirationCalendar importerId={importer.id} />
        </div>

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            On-chain event log
          </h2>
          <EventLog
            key={importer.id + '-' + refreshCount}
            importerId={importer.id}
            events={events}
            setEvents={setEvents}
          />
        </div>
      </main>

      {/* #1035: a fixed, non-modal corner card — never overlaps deposit/withdraw
          controls in the page flow above, and stays hidden entirely while an
          action (deposit, withdraw, top-up) is in flight. */}
      {busy === null && <NpsSurvey />}
    </>
  );
}

function oracleNote() {
  return 'Set by platform admin acting as tariff oracle';
}

/**
 * MetricsCard equivalent (#254): a single stat tile. Memoized so a re-render
 * of the parent dashboard doesn't re-render every tile unless its own
 * label/value/hint/accent actually changed.
 */
const Stat = memo(function Stat({
  label,
  value,
  hint,
  accent,
  converted,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'success' | 'danger';
  /** Issue #1037 — approximate display-currency equivalent shown alongside the base-token value. */
  converted?: string;
}) {
  const color =
    accent === 'success' ? 'text-success' : accent === 'danger' ? 'text-danger' : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
      {converted ? <p className="mt-0.5 text-xs text-muted">≈ {converted}</p> : null}
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
});

/**
 * BalanceSummary (#254): the four balance tiles + utilization bar. Formatted
 * XLM strings and the bar's derived class/width are memoized so this block
 * only re-renders when the underlying on-chain account snapshot changes,
 * not on every parent re-render (e.g. toggling `busy`/`error`).
 */
const BalanceSummary = memo(function BalanceSummary({
  onChainAccount,
  shortfall,
  excess,
  utilization,
  rate,
}: {
  onChainAccount: ImporterDetail['onChainAccount'];
  shortfall: bigint;
  excess: bigint;
  utilization: number;
  /** Issue #1037 — optional display-currency conversion, purely presentational. */
  rate?: import('@/lib/currency').ExchangeRate | null;
}) {
  const formatted = useMemo(
    () => ({
      required: stroopsToXlm(onChainAccount.requiredCollateral),
      collateral: stroopsToXlm(onChainAccount.collateralBalance),
      reserve: stroopsToXlm(onChainAccount.reserveBalance),
      yieldAccrued: stroopsToXlm(onChainAccount.yieldAccrued),
      shortfall: stroopsToXlm(shortfall.toString()),
      excess: stroopsToXlm(excess.toString()),
    }),
    [
      onChainAccount.requiredCollateral,
      onChainAccount.collateralBalance,
      onChainAccount.reserveBalance,
      onChainAccount.yieldAccrued,
      shortfall,
      excess,
    ]
  );

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat
          label="Required collateral"
          value={`${formatted.required} XLM`}
          hint={oracleNote()}
          converted={rate ? formatConverted(onChainAccount.requiredCollateral, rate) : undefined}
        />
        <Stat
          label="Posted collateral"
          value={`${formatted.collateral} XLM`}
          accent={shortfall > 0n ? 'danger' : 'success'}
          converted={rate ? formatConverted(onChainAccount.collateralBalance, rate) : undefined}
        />
        <Stat
          label="Reserve (auto-top-up pool)"
          value={`${formatted.reserve} XLM`}
          converted={rate ? formatConverted(onChainAccount.reserveBalance, rate) : undefined}
        />
        <Stat
          label="Yield accrued (sim BENJI)"
          value={`${formatted.yieldAccrued} XLM`}
          accent="success"
        />
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-muted">Bond utilization</span>
          <span className="font-mono">{utilization}%</span>
        </div>
        <div className="h-2 bg-border rounded overflow-hidden">
          <div
            className={`h-full ${shortfall > 0n ? 'bg-danger' : 'bg-success'}`}
            style={{ width: `${Math.min(utilization, 100)}%` }}
          />
        </div>
        {shortfall > 0n ? (
          <p className="mt-2 text-xs text-danger">
            Shortfall <span className="font-mono">{formatted.shortfall} XLM</span> — auto-top-up
            will draw from reserve.
          </p>
        ) : excess > 0n ? (
          <p className="mt-2 text-xs text-success">
            Excess <span className="font-mono">{formatted.excess} XLM</span> — withdrawable.
          </p>
        ) : null}
      </div>
    </>
  );
});

/**
 * YieldProjectionPanel (#260): compound-interest / top-up-schedule scenario
 * modeling, run in a WebWorker (lib/workers/yieldWorker.ts) instead of the
 * main thread — recalculating on every input change would otherwise block
 * rendering/event handling for the duration of the calculation.
 */
function YieldProjectionPanel({ currentBalanceStroops }: { currentBalanceStroops: string }) {
  const [months, setMonths] = useState(24);
  const [monthlyTopUpXlm, setMonthlyTopUpXlm] = useState('0');
  const [annualYieldBps, setAnnualYieldBps] = useState(500); // 5%
  const { result, error, loading, project } = useYieldProjection();

  useEffect(() => {
    const monthlyTopUpStroops = String(BigInt(Math.round(Number(monthlyTopUpXlm) * 1e7)) || 0n);
    project({ currentBalanceStroops, monthlyTopUpStroops, months, annualYieldBps });
    // Re-run whenever any input (or the on-chain balance) changes.
  }, [currentBalanceStroops, monthlyTopUpXlm, months, annualYieldBps, project]);

  return (
    <div className="mt-4 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Yield projection (sim BENJI)</h3>
      <p className="mt-1 text-xs text-muted">
        Computed off the main thread — typing here never blocks the UI.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs text-muted">Months</span>
          <input
            type="number"
            min={1}
            max={600}
            value={months}
            onChange={(e) => setMonths(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-muted">Monthly top-up (XLM)</span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={monthlyTopUpXlm}
            onChange={(e) => setMonthlyTopUpXlm(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="block text-xs text-muted">Simulated annual yield (bps)</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={10}
            value={annualYieldBps}
            onChange={(e) =>
              setAnnualYieldBps(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))
            }
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-3">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : result ? (
          <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <p className="text-sm">
              Projected balance after <span className="font-mono">{result.months}</span> months:{' '}
              <span className="font-mono font-semibold">
                {stroopsToXlm(result.projectedBalanceStroops)} XLM
              </span>{' '}
              <span className="text-xs text-muted">
                ({Number(result.totalYieldStroops) >= 0 ? '+' : ''}
                {stroopsToXlm(result.totalYieldStroops)} XLM yield)
              </span>
            </p>
            <YieldProjectionChart monthly={result.monthly} />
          </div>
        ) : loading ? (
          <p className="text-sm text-muted">Calculating…</p>
        ) : null}
      </div>
    </div>
  );
}

/** Rounds a tick step up to a "nice" 1/2/5 × 10^n value. */
function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const niceResidual = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return niceResidual * magnitude;
}

/** Produces ~tickCount evenly-spaced, human-readable tick values spanning [min, max]. */
function niceTicks(min: number, max: number, tickCount = 4): number[] {
  if (min === max) return [min, min + 1];
  const step = niceStep((max - min) / (tickCount - 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(v);
  return ticks;
}

const CHART_W = 600;
const CHART_H = 200;
const CHART_PAD = { top: 12, right: 12, bottom: 24, left: 56 };

/**
 * Line/area render of the worker-computed month-by-month balance (#260
 * follow-up) — plots `result.monthly` from useYieldProjection as-is, so it
 * shares the same computation the summary line already uses and never
 * triggers extra work on the main thread.
 */
function YieldProjectionChart({ monthly }: { monthly: YieldProjectionResponse['monthly'] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const values = useMemo(
    () => monthly.map((m) => Number(stroopsToXlm(m.balanceStroops))),
    [monthly]
  );

  const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;
  const bottomY = CHART_PAD.top + plotH;

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const yTicks = niceTicks(dataMin, dataMax, 4);
  const yDomainMin = yTicks[0];
  const yDomainMax = yTicks[yTicks.length - 1];
  const yRange = yDomainMax - yDomainMin || 1;

  const xScale = (i: number) =>
    values.length > 1
      ? CHART_PAD.left + (i / (values.length - 1)) * plotW
      : CHART_PAD.left + plotW / 2;
  const yScale = (v: number) => CHART_PAD.top + (1 - (v - yDomainMin) / yRange) * plotH;

  const linePoints = values.map((v, i) => `${xScale(i)},${yScale(v)}`);
  const linePath = `M${linePoints.join(' L')}`;
  const areaPath = `${linePath} L${xScale(values.length - 1)},${bottomY} L${xScale(0)},${bottomY} Z`;

  const xTickIdxs = Array.from(
    new Set([0, Math.floor((values.length - 1) / 2), values.length - 1].filter((i) => i >= 0))
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const svg = svgRef.current;
      if (!svg || values.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * CHART_W;
      const clamped = Math.max(CHART_PAD.left, Math.min(CHART_PAD.left + plotW, relX));
      const t = values.length > 1 ? (clamped - CHART_PAD.left) / plotW : 0;
      setHoverIdx(Math.round(t * (values.length - 1)));
    },
    [values.length, plotW]
  );

  if (values.length === 0) return null;

  const hovered = hoverIdx !== null ? monthly[hoverIdx] : null;
  const hoveredValue = hoverIdx !== null ? values[hoverIdx] : null;

  return (
    <div className="mt-3 w-full" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={`Projected balance over ${monthly.length} months, from ${values[0].toFixed(2)} to ${values[values.length - 1].toFixed(2)} XLM`}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={CHART_PAD.left}
              x2={CHART_W - CHART_PAD.right}
              y1={yScale(t)}
              y2={yScale(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={CHART_PAD.left - 8}
              y={yScale(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted font-mono"
              fontSize={9}
            >
              {t.toLocaleString(undefined, { maximumFractionDigits: t % 1 === 0 ? 0 : 2 })}
            </text>
          </g>
        ))}

        {xTickIdxs.map((i) => (
          <text
            key={i}
            x={xScale(i)}
            y={CHART_H - 6}
            textAnchor={i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}
            className="fill-muted font-mono"
            fontSize={9}
          >
            M{monthly[i].month}
          </text>
        ))}

        <path d={areaPath} fill="var(--accent)" fillOpacity={0.1} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <circle
          cx={xScale(values.length - 1)}
          cy={yScale(values[values.length - 1])}
          r={4}
          fill="var(--accent)"
          stroke="var(--card)"
          strokeWidth={2}
        />

        {hoverIdx !== null && hoveredValue !== null && (
          <>
            <line
              x1={xScale(hoverIdx)}
              x2={xScale(hoverIdx)}
              y1={CHART_PAD.top}
              y2={bottomY}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <circle
              cx={xScale(hoverIdx)}
              cy={yScale(hoveredValue)}
              r={4}
              fill="var(--accent)"
              stroke="var(--card)"
              strokeWidth={2}
            />
          </>
        )}

        <rect
          x={CHART_PAD.left}
          y={CHART_PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIdx(null)}
        />
      </svg>
      {hovered && hoveredValue !== null && (
        <p className="mt-1 text-center text-xs text-muted">
          Month <span className="font-mono">{hovered.month}</span>:{' '}
          <span className="font-mono font-semibold text-foreground">
            {hoveredValue.toLocaleString(undefined, { maximumFractionDigits: 4 })} XLM
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * EventLog (#255): lazy-loads the event log with infinite scroll +
 * cursor pagination. Nothing is fetched until the section (specifically,
 * the sentinel div at its bottom) scrolls within 200px of the viewport,
 * deferring this network call and its DOM nodes off the initial page load.
 */
function EventLog({
  importerId,
  events,
  setEvents,
}: {
  importerId: string;
  events: ContractEvent[];
  setEvents: React.Dispatch<React.SetStateAction<ContractEvent[]>>;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FormattedError | string | null>(null);
  const [started, setStarted] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  const loadNextPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.getImporterEventsCursor(importerId, cursor);
      const fresh = page.data.filter((e) => !seenIds.current.has(e.id));
      for (const e of fresh) seenIds.current.add(e.id);
      setEvents((prev) => [...prev, ...fresh]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  }, [importerId, cursor, setEvents]);

  // Fires the *first* page load once the sentinel enters the viewport, and
  // every subsequent page as the user scrolls within 200px of the bottom.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          if (!started) setStarted(true);
          if (hasMore && !loading) loadNextPage();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- observer re-attach is driven by loadNextPage identity
  }, [loadNextPage, hasMore, loading, started]);

  return (
    <>
      {!started && !loading && events.length === 0 && !error ? (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <p className="text-sm text-muted">Scroll to load event history…</p>
          <button
            type="button"
            onClick={() => {
              setStarted(true);
              loadNextPage();
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-card"
          >
            Load event history
          </button>
        </div>
      ) : events.length === 0 && !loading && !error ? (
        <p className="mt-3 text-sm text-muted">No events yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
          {events.map((e) => (
            <EventLogRow key={e.id} event={e} />
          ))}
        </ul>
      )}

      {loading ? (
        <p className="mt-3 text-sm text-muted">Loading events…</p>
      ) : error ? (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="font-medium text-danger">
                {events.length > 0
                  ? `Couldn't load more events: ${formatApiError(error).userMessage}`
                  : `Couldn't load event history: ${formatApiError(error).userMessage}`}
              </p>
              {events.length > 0 && (
                <p className="mt-1 text-xs text-muted">
                  Previously loaded events remain visible and unaffected.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={loadNextPage}
              className="self-start sm:self-center shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-card"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {/* Sentinel: IntersectionObserver target, 200px above the true bottom via rootMargin. */}
      <div ref={sentinelRef} />
    </>
  );
}

/**
 * EventLogRow (#254): a single on-chain event row. Memoized so unrelated
 * dashboard re-renders (busy state, error banner, form inputs) don't
 * re-render the full event list — only rows whose own event data changed.
 */
const EventLogRow = memo(function EventLogRow({ event }: { event: ContractEvent }) {
  const amountLabel = useMemo(() => getEventAmountLabel(event), [event]);
  return (
    <li className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{event.kind}</p>
        <p className="text-xs text-muted">{new Date(event.createdAt).toLocaleString()}</p>
      </div>
      <span className="text-sm font-mono">{amountLabel}</span>
      {event.txUrl ? (
        <a
          href={event.txUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline font-mono"
        >
          {event.txHash.slice(0, 8)}…
        </a>
      ) : null}
    </li>
  );
});

// #1082: this card deliberately renders no busy text of its own. Each action
// below owns exactly one busy indicator, shown on the control that started it,
// so a single in-flight action never surfaces two differently-worded messages.
function ActionCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-3">{action}</div>
    </div>
  );
}

function TariffForm({
  importerId,
  currentRequiredStroops,
  onDone,
  setError,
}: {
  importerId: string;
  currentRequiredStroops: string;
  onDone: () => Promise<void>;
  setError: (e: FormattedError | string | null) => void;
}) {
  const [duty, setDuty] = useState('5000000');
  const [busy, setBusy] = useState(false);

  // Mirror of the server-side / documented formula: required = annual_duty × 10% × 50%,
  // scaled to stroops (1 XLM = 1e7). Recomputed live as the duty input changes so the
  // importer sees the resulting requirement before committing the on-chain update.
  const preview = useMemo(() => {
    const d = Number(duty);
    if (!Number.isFinite(d) || d <= 0) return null;
    const nextStroops = BigInt(Math.round(d * 0.05 * 1e7));
    const currentStroops = BigInt(currentRequiredStroops);
    return {
      nextStroops,
      deltaStroops: nextStroops - currentStroops,
    };
  }, [duty, currentRequiredStroops]);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api.uploadTariffCsv(importerId, {
        annualDutyTotal: Number(duty),
        filename: 'manual-entry.csv',
      });
      await onDone();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="flex gap-2">
        <input
          type="number"
          min={100}
          value={duty}
          onChange={(e) => setDuty(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
        <button
          onClick={go}
          disabled={busy || !preview}
          className="rounded-md border border-accent text-accent px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
      {formatUsd(duty) ? (
        <p className="mt-1 text-xs font-mono text-muted">
          {formatUsd(duty)} <span className="font-sans">annual duty</span>
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        {preview ? (
          <>
            New required collateral{' '}
            <span className="font-mono text-foreground">
              {stroopsToXlm(preview.nextStroops.toString())} XLM
            </span>
            {preview.deltaStroops !== 0n ? (
              <>
                {' '}
                <span
                  className={`font-mono ${preview.deltaStroops > 0n ? 'text-danger' : 'text-success'}`}
                >
                  ({preview.deltaStroops > 0n ? '+' : '−'}
                  {stroopsToXlm(
                    (preview.deltaStroops < 0n
                      ? -preview.deltaStroops
                      : preview.deltaStroops
                    ).toString()
                  )}{' '}
                  XLM)
                </span>
              </>
            ) : (
              ' (no change)'
            )}
          </>
        ) : (
          'Enter an annual duty estimate to preview the new requirement.'
        )}
      </p>
    </div>
  );
}

function WithdrawCard({
  importerId,
  maxStroops,
  onDone,
  setError,
}: {
  importerId: string;
  maxStroops: string;
  onDone: () => Promise<void>;
  setError: (e: FormattedError | string | null) => void;
}) {
  const maxXlm = stroopsToXlm(maxStroops);
  const [xlm, setXlm] = useState(maxXlm);
  const [busy, setBusy] = useState(false);
  const atMax = xlm === maxXlm;
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api.withdraw(importerId, {
        amountStroops: BigInt(Math.round(Number(xlm) * 1e7)).toString(),
      });
      await onDone();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between text-xs text-muted mb-1.5">
        <span>Amount to withdraw (XLM)</span>
        <span className="font-mono">Max {maxXlm}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step="0.01"
          value={xlm}
          onChange={(e) => setXlm(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setXlm(maxXlm)}
          disabled={busy || atMax}
          className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-background disabled:opacity-50"
        >
          Max
        </button>
        <button
          onClick={go}
          disabled={busy}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card disabled:opacity-50"
        >
          {busy ? '…' : 'Withdraw excess'}
        </button>
      </div>
    </div>
  );
}

function RegisterImporter({
  onCreated,
  setError,
  error,
}: {
  onCreated: () => Promise<void>;
  setError: (e: FormattedError | string | null) => void;
  error: FormattedError | string | null;
}) {
  const [form, setForm] = useState({ legalName: '', ein: '', annualDutyEstimate: '5000000' });
  const [fieldErrors, setFieldErrors] = useState<{
    legalName?: string;
    ein?: string;
    annualDutyEstimate?: string;
  }>({});
  const [busy, setBusy] = useState(false);

  function validate(): boolean {
    const errs: { legalName?: string; ein?: string; annualDutyEstimate?: string } = {};
    if (!form.legalName.trim()) {
      errs.legalName = 'Legal name is required';
    }
    if (form.ein.trim() && !/^\d{2}-\d{7}$/.test(form.ein.trim())) {
      errs.ein = 'EIN must be formatted as XX-XXXXXXX (e.g. 12-3456789)';
    }
    const dutyNum = Number(form.annualDutyEstimate);
    if (!form.annualDutyEstimate || !Number.isFinite(dutyNum) || dutyNum < 100) {
      errs.annualDutyEstimate = 'Annual duty estimate must be at least $100';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  const updateField = (field: 'legalName' | 'ein' | 'annualDutyEstimate', value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      // Initial required collat estimate: same formula as tariff CSV (annual × 10% × 50% × 1e7 stroops)
      const stroops = BigInt(Math.round(Number(form.annualDutyEstimate) * 0.05 * 1e7));
      await api.createImporter({
        legalName: form.legalName.trim(),
        ein: form.ein.trim() || undefined,
        bondId: Math.floor(Date.now() / 1000),
        initialRequiredCollateral: stroops.toString(),
      });
      await onCreated();
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="max-w-md mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Register your importer entity</h1>
      <p className="mt-1 text-sm text-muted">
        Funds a Stellar testnet account + registers your bond on-chain. ~5 sec.
      </p>
      <form onSubmit={go} className="mt-8 space-y-4">
        <Field
          label="Legal name"
          value={form.legalName}
          onChange={(v) => updateField('legalName', v)}
          placeholder="Wayfair Imports Inc"
          required
          error={fieldErrors.legalName}
        />
        <Field
          label="EIN (optional)"
          value={form.ein}
          onChange={(v) => updateField('ein', v)}
          placeholder="12-3456789"
          error={fieldErrors.ein}
        />
        <Field
          label="Annual customs duty estimate (USD)"
          type="number"
          value={form.annualDutyEstimate}
          onChange={(v) => updateField('annualDutyEstimate', v)}
          required
          error={fieldErrors.annualDutyEstimate}
          hint={
            formatUsd(form.annualDutyEstimate) ? (
              <span className="font-mono">{formatUsd(form.annualDutyEstimate)}</span>
            ) : null
          }
        />
        <ErrorBanner error={error} />
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 text-accent-foreground hover:opacity-90 disabled:opacity-50 text-sm font-medium"
        >
          {busy ? (
            <>
              <Spinner />
              Registering on Stellar testnet…
            </>
          ) : (
            'Register importer'
          )}
        </button>
      </form>
    </main>
  );
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  required,
  hint,
  error,
}: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Read-only line rendered under the input — e.g. a formatted currency preview. */
  hint?: React.ReactNode;
  /** Field-specific error guidance text. */
  error?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className={`mt-1 block w-full rounded-md border ${
          error ? 'border-danger' : 'border-border'
        } bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent`}
      />
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export default Sentry.withErrorBoundary(ImporterDashboard, {
  fallback: ({ error }: { error: any }) => (
    <div className="max-w-md mx-auto px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-danger">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        An unexpected client-side error occurred. The engineering team has been notified.
      </p>
      {error && (
        <pre className="mt-4 p-3 rounded bg-card border border-border text-xs text-muted overflow-auto font-mono text-left">
          {String(error.message || error)}
        </pre>
      )}
    </div>
  ),
});
