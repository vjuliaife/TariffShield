"use client";

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
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { Nav } from "@/components/Nav";
import { HealthScore } from "@/components/HealthScore";
import { DepositWizard } from "@/components/DepositWizard";
import { BondTimeline } from "@/components/BondTimeline";
import { api, ApiError, type ContractEvent, type Importer, type ImporterDetail, stroopsToXlm } from "@/lib/api";
import { getUser, isAuthenticated } from "@/lib/auth";
import { useYieldProjection } from "@/lib/workers/useYieldProjection";
import * as Sentry from "@sentry/nextjs";

function ImporterDashboard() {
  const router = useRouter();
  const [importer, setImporter] = useState<Importer | null>(null);
  const [detail, setDetail] = useState<ImporterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  const action = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleTopUp = useCallback(() => {
    if (!importer) return;
    return action("topup", () => api.autoTopUp(importer.id));
  }, [action, importer]);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/login"); return; }
    const user = getUser();
    if (user?.role !== "importer") { router.replace("/surety"); return; }
    refresh();
  }, [router, refresh]);

  const onc = detail?.onChainAccount;

  // Derived values recomputed only when the on-chain account snapshot changes,
  // not on every render triggered by unrelated state (busy, error, etc.).
  const { required, collateral, reserve, shortfall, excess, utilization } = useMemo(() => {
    if (!onc) return { required: 0n, collateral: 0n, reserve: 0n, shortfall: 0n, excess: 0n, utilization: 0 };
    const required = BigInt(onc.requiredCollateral);
    const collateral = BigInt(onc.collateralBalance);
    const reserve = BigInt(onc.reserveBalance);
    const shortfall = required > collateral ? required - collateral : 0n;
    const excess = collateral > required ? collateral - required : 0n;
    const utilization = required === 0n ? 0 : Number((collateral * 100n) / required);
    return { required, collateral, reserve, shortfall, excess, utilization };
  }, [onc]);

  if (!importer) {
    return (
      <>
        <Nav />
        <RegisterImporter onCreated={refresh} setError={setError} error={error} />
      </>
    );
  }

  if (!detail) {
    return (<><Nav /><main className="max-w-4xl mx-auto px-6 py-10"><p className="text-muted">Loading…</p></main></>);
  }

  const account = detail.onChainAccount;

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
              {importer.ein ? <> · EIN <span className="font-mono">{importer.ein}</span></> : null}
            </p>
            <p className="mt-1 text-xs text-muted font-mono break-all">{importer.stellarAddress}</p>
          </div>
          {detail.importer.registeredOnChainTx ? (
            <a className="text-xs text-accent hover:underline font-mono"
               href={`https://stellar.expert/explorer/testnet/tx/${detail.importer.registeredOnChainTx}`}
               target="_blank" rel="noopener noreferrer">
              registration tx ↗
            </a>
          ) : null}
        </div>

        {account.isClawbacked ? (
          <div className="mt-6 rounded-lg border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
            <strong>Account frozen by surety.</strong> All collateral + reserve has been clawed back. No further deposits or withdrawals allowed.
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-5 mt-6">
          <div className="sm:col-span-2">
            <HealthScore collateral={collateral} required={required} reserve={reserve} />
          </div>
          <div className="sm:col-span-3">
            <BalanceSummary
              onChainAccount={account}
              shortfall={shortfall}
              excess={excess}
              utilization={utilization}
            />
          </div>
        </div>

        <YieldProjectionPanel currentBalanceStroops={account.collateralBalance} />

        {!account.isClawbacked && (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <ActionCard title="Update tariff exposure"
                        description="Re-run required collateral from annual duty estimate. Demo computes required = annual_duty × 10% × 50%."
                        action={<TariffForm importerId={importer.id} onDone={refresh} setError={setError} />}
                        busy={busy === "tariff"} />
            <ActionCard title="Deposit collateral"
                        description="Send XLM into the bond escrow bucket. 4-step wizard guides you through the process."
                        action={<DepositWizard importerId={importer.id} bucket="collateral" onDone={refresh} setError={setError} />}
                        busy={busy === "deposit-collateral"} />
            <ActionCard title="Deposit reserve"
                        description="Top up the auto-top-up pool for tariff spike events. 4-step wizard guides you through the process."
                        action={<DepositWizard importerId={importer.id} bucket="reserve" onDone={refresh} setError={setError} />}
                        busy={busy === "deposit-reserve"} />
          </div>
        )}

        {!account.isClawbacked && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <button
              onClick={handleTopUp}
              disabled={busy !== null || shortfall === 0n}
              className="rounded-md bg-accent px-4 py-3 text-accent-foreground hover:opacity-90 disabled:opacity-40 text-sm font-medium"
            >
              {busy === "topup" ? "Calling auto_top_up on-chain…" :
                shortfall === 0n ? "auto_top_up (no shortfall)" :
                `auto_top_up — move ${stroopsToXlm(shortfall.toString())} XLM from reserve`}
            </button>
            {excess > 0n ? (
              <WithdrawCard importerId={importer.id} maxStroops={excess.toString()} onDone={refresh} setError={setError} />
            ) : <div className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted">No excess to withdraw.</div>}
          </div>
        )}

        {error ? <p className="mt-4 rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

        <BondTimeline events={detail.events} />

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">On-chain event log</h2>
          <EventLog importerId={importer.id} />
        </div>
      </main>
    </>
  );
}

function oracleNote() {
  return "Set by platform admin acting as tariff oracle";
}

/**
 * MetricsCard equivalent (#254): a single stat tile. Memoized so a re-render
 * of the parent dashboard doesn't re-render every tile unless its own
 * label/value/hint/accent actually changed.
 */
const Stat = memo(function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "success" | "danger" }) {
  const color = accent === "success" ? "text-success" : accent === "danger" ? "text-danger" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
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
}: {
  onChainAccount: ImporterDetail["onChainAccount"];
  shortfall: bigint;
  excess: bigint;
  utilization: number;
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
    [onChainAccount.requiredCollateral, onChainAccount.collateralBalance, onChainAccount.reserveBalance, onChainAccount.yieldAccrued, shortfall, excess],
  );

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Required collateral" value={`${formatted.required} XLM`} hint={oracleNote()} />
        <Stat label="Posted collateral" value={`${formatted.collateral} XLM`} accent={shortfall > 0n ? "danger" : "success"} />
        <Stat label="Reserve (auto-top-up pool)" value={`${formatted.reserve} XLM`} />
        <Stat label="Yield accrued (sim BENJI)" value={`${formatted.yieldAccrued} XLM`} accent="success" />
      </div>

      <div className="mt-4 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-muted">Bond utilization</span>
          <span className="font-mono">{utilization}%</span>
        </div>
        <div className="h-2 bg-border rounded overflow-hidden">
          <div className={`h-full ${shortfall > 0n ? "bg-danger" : "bg-success"}`}
               style={{ width: `${Math.min(utilization, 100)}%` }} />
        </div>
        {shortfall > 0n ? (
          <p className="mt-2 text-xs text-danger">
            Shortfall <span className="font-mono">{formatted.shortfall} XLM</span> — auto-top-up will draw from reserve.
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
  const [monthlyTopUpXlm, setMonthlyTopUpXlm] = useState("0");
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
      <p className="mt-1 text-xs text-muted">Computed off the main thread — typing here never blocks the UI.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="block text-xs text-muted">Months</span>
          <input type="number" min={1} max={600} value={months}
            onChange={(e) => setMonths(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
        </label>
        <label className="block">
          <span className="block text-xs text-muted">Monthly top-up (XLM)</span>
          <input type="number" min={0} step="0.1" value={monthlyTopUpXlm}
            onChange={(e) => setMonthlyTopUpXlm(e.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
        </label>
        <label className="block">
          <span className="block text-xs text-muted">Simulated annual yield (bps)</span>
          <input type="number" min={0} max={10000} step={10} value={annualYieldBps}
            onChange={(e) => setAnnualYieldBps(Math.max(0, Math.min(10000, Number(e.target.value) || 0)))}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
        </label>
      </div>

      <div className="mt-3">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : result ? (
          <p className="text-sm">
            Projected balance after <span className="font-mono">{result.months}</span> months:{" "}
            <span className="font-mono font-semibold">{stroopsToXlm(result.projectedBalanceStroops)} XLM</span>{" "}
            <span className="text-xs text-muted">
              ({Number(result.totalYieldStroops) >= 0 ? "+" : ""}{stroopsToXlm(result.totalYieldStroops)} XLM yield)
            </span>
          </p>
        ) : loading ? (
          <p className="text-sm text-muted">Calculating…</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * EventLog (#255): lazy-loads the event log with infinite scroll +
 * cursor pagination. Nothing is fetched until the section (specifically,
 * the sentinel div at its bottom) scrolls within 200px of the viewport,
 * deferring this network call and its DOM nodes off the initial page load.
 */
function EventLog({ importerId }: { importerId: string }) {
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const seenIds = useRef<Set<string>>(new Set());

  const loadNextPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.getImporterEventsCursor(importerId, cursor);
      const fresh = page.events.filter((e) => !seenIds.current.has(e.id));
      for (const e of fresh) seenIds.current.add(e.id);
      setEvents((prev) => [...prev, ...fresh]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [importerId, cursor]);

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
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- observer re-attach is driven by loadNextPage identity
  }, [loadNextPage, hasMore, loading, started]);

  return (
    <>
      {!started && !loading && events.length === 0 && !error ? (
        <p className="mt-3 text-sm text-muted">Scroll to load event history…</p>
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
        <div className="mt-3 flex items-center gap-3">
          <p className="text-sm text-danger">{error}</p>
          <button
            onClick={loadNextPage}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
          >
            Retry
          </button>
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
  const amountLabel = useMemo(
    () => (event.amount ? `${stroopsToXlm(event.amount)} XLM` : "—"),
    [event.amount],
  );
  return (
    <li className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{event.kind}</p>
        <p className="text-xs text-muted">{new Date(event.createdAt).toLocaleString()}</p>
      </div>
      <span className="text-sm font-mono">{amountLabel}</span>
      {event.txUrl ? (
        <a href={event.txUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline font-mono">
          {event.txHash.slice(0, 8)}…
        </a>
      ) : null}
    </li>
  );
});

function ActionCard({ title, description, action, busy }: { title: string; description: string; action: React.ReactNode; busy: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-3">{action}</div>
      {busy ? <p className="mt-2 text-xs text-accent">Submitting to Stellar…</p> : null}
    </div>
  );
}

function TariffForm({ importerId, onDone, setError }: { importerId: string; onDone: () => Promise<void>; setError: (e: string | null) => void }) {
  const [duty, setDuty] = useState("5000000");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api.uploadTariffCsv(importerId, { annualDutyTotal: Number(duty), filename: "manual-entry.csv" });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }
  return (
    <div className="flex gap-2">
      <input type="number" min={100} value={duty} onChange={(e) => setDuty(e.target.value)}
        className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
      <button onClick={go} disabled={busy}
        className="rounded-md border border-accent text-accent px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50">
        {busy ? "…" : "Apply"}
      </button>
    </div>
  );
}

function WithdrawCard({ importerId, maxStroops, onDone, setError }: { importerId: string; maxStroops: string; onDone: () => Promise<void>; setError: (e: string | null) => void }) {
  const [xlm, setXlm] = useState(stroopsToXlm(maxStroops));
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api.withdraw(importerId, { amountStroops: (BigInt(Math.round(Number(xlm) * 1e7))).toString() });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 flex items-center gap-2">
      <input type="number" step="0.01" value={xlm} onChange={(e) => setXlm(e.target.value)}
        className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
      <button onClick={go} disabled={busy}
        className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card disabled:opacity-50">
        {busy ? "…" : "Withdraw excess"}
      </button>
    </div>
  );
}

function RegisterImporter({ onCreated, setError, error }: { onCreated: () => Promise<void>; setError: (e: string | null) => void; error: string | null }) {
  const [form, setForm] = useState({ legalName: "", ein: "", annualDutyEstimate: "5000000" });
  const [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Initial required collat estimate: same formula as tariff CSV (annual × 10% × 50% × 1e7 stroops)
      const stroops = BigInt(Math.round(Number(form.annualDutyEstimate) * 0.05 * 1e7));
      await api.createImporter({
        legalName: form.legalName,
        ein: form.ein || undefined,
        bondId: Math.floor(Date.now() / 1000),
        initialRequiredCollateral: stroops.toString(),
      });
      await onCreated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }
  return (
    <main className="max-w-md mx-auto px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Register your importer entity</h1>
      <p className="mt-1 text-sm text-muted">Funds a Stellar testnet account + registers your bond on-chain. ~5 sec.</p>
      <form onSubmit={go} className="mt-8 space-y-4">
        <Field label="Legal name" value={form.legalName} onChange={(v) => setForm({ ...form, legalName: v })} placeholder="Wayfair Imports Inc" required />
        <Field label="EIN (optional)" value={form.ein} onChange={(v) => setForm({ ...form, ein: v })} placeholder="12-3456789" />
        <Field label="Annual customs duty estimate (USD)" type="number" value={form.annualDutyEstimate} onChange={(v) => setForm({ ...form, annualDutyEstimate: v })} required />
        {error ? <p className="rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
        <button type="submit" disabled={busy}
          className="rounded-md bg-accent px-4 py-2.5 text-accent-foreground hover:opacity-90 disabled:opacity-50 text-sm font-medium">
          {busy ? "Registering on Stellar testnet…" : "Register importer"}
        </button>
      </form>
    </main>
  );
}

function Field({ label, type = "text", value, onChange, placeholder, required }: { label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required}
        className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent" />
    </label>
  );
}

export default Sentry.withErrorBoundary(ImporterDashboard, {
  fallback: ({ error }: { error: any }) => (
    <div className="max-w-md mx-auto px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-danger">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">An unexpected client-side error occurred. The engineering team has been notified.</p>
      {error && (
        <pre className="mt-4 p-3 rounded bg-card border border-border text-xs text-muted overflow-auto font-mono text-left">
          {String(error.message || error)}
        </pre>
      )}
    </div>
  ),
});
