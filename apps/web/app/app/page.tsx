"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { api, ApiError, type Importer, type ImporterDetail, stroopsToXlm } from "@/lib/api";
import { getUser, isAuthenticated } from "@/lib/auth";
import * as Sentry from "@sentry/nextjs";

function ImporterDashboard() {
  const router = useRouter();
  const [importer, setImporter] = useState<Importer | null>(null);
  const [detail, setDetail] = useState<ImporterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/login"); return; }
    const user = getUser();
    if (user?.role !== "importer") { router.replace("/surety"); return; }
    refresh();
  }, [router]);

  async function refresh() {
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
  }

  async function action(name: string, fn: () => Promise<unknown>) {
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
  }

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

  const onc = detail.onChainAccount;
  const required = BigInt(onc.requiredCollateral);
  const collateral = BigInt(onc.collateralBalance);
  const reserve = BigInt(onc.reserveBalance);
  const yieldAcc = BigInt(onc.yieldAccrued);
  const shortfall = required > collateral ? required - collateral : 0n;
  const excess = collateral > required ? collateral - required : 0n;
  const utilization = required === 0n ? 0 : Number((collateral * 100n) / required);

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

        {onc.isClawbacked ? (
          <div className="mt-6 rounded-lg border border-danger bg-danger/10 px-4 py-3 text-sm text-danger">
            <strong>Account frozen by surety.</strong> All collateral + reserve has been clawed back. No further deposits or withdrawals allowed.
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <Stat label="Required collateral" value={`${stroopsToXlm(onc.requiredCollateral)} XLM`} hint={oracleNote()} />
          <Stat label="Posted collateral" value={`${stroopsToXlm(onc.collateralBalance)} XLM`} accent={shortfall > 0n ? "danger" : "success"} />
          <Stat label="Reserve (auto-top-up pool)" value={`${stroopsToXlm(onc.reserveBalance)} XLM`} />
          <Stat label="Yield accrued (sim BENJI)" value={`${stroopsToXlm(onc.yieldAccrued)} XLM`} accent="success" />
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
              Shortfall <span className="font-mono">{stroopsToXlm(shortfall.toString())} XLM</span> — auto-top-up will draw from reserve.
            </p>
          ) : excess > 0n ? (
            <p className="mt-2 text-xs text-success">
              Excess <span className="font-mono">{stroopsToXlm(excess.toString())} XLM</span> — withdrawable.
            </p>
          ) : null}
        </div>

        {!onc.isClawbacked && (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <ActionCard title="Update tariff exposure"
                        description="Re-run required collateral from annual duty estimate. Demo computes required = annual_duty × 10% × 50%."
                        action={<TariffForm importerId={importer.id} onDone={refresh} setError={setError} />}
                        busy={busy === "tariff"} />
            <ActionCard title="Deposit collateral"
                        description="Send USDC into the bond escrow bucket."
                        action={<DepositForm importerId={importer.id} bucket="collateral" onDone={refresh} setError={setError} />}
                        busy={busy === "deposit-collateral"} />
            <ActionCard title="Deposit reserve"
                        description="Top up the auto-top-up pool for tariff spike events."
                        action={<DepositForm importerId={importer.id} bucket="reserve" onDone={refresh} setError={setError} />}
                        busy={busy === "deposit-reserve"} />
          </div>
        )}

        {!onc.isClawbacked && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <button
              onClick={() => action("topup", () => api.autoTopUp(importer.id))}
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

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">On-chain event log</h2>
          {detail.events.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No events yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
              {detail.events.map((e) => (
                <li key={e.id} className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{e.kind}</p>
                    <p className="text-xs text-muted">{new Date(e.createdAt).toLocaleString()}</p>
                  </div>
                  <span className="text-sm font-mono">{e.amount ? `${stroopsToXlm(e.amount)} XLM` : "—"}</span>
                  {e.txUrl ? (
                    <a href={e.txUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline font-mono">
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

function oracleNote() {
  return "Set by platform admin acting as tariff oracle";
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "success" | "danger" }) {
  const color = accent === "success" ? "text-success" : accent === "danger" ? "text-danger" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

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

function DepositForm({ importerId, bucket, onDone, setError }: { importerId: string; bucket: "collateral" | "reserve"; onDone: () => Promise<void>; setError: (e: string | null) => void }) {
  const [xlm, setXlm] = useState("50");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const stroops = (BigInt(Math.round(Number(xlm) * 1e7))).toString();
      await api.deposit(importerId, { amountStroops: stroops, bucket });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }
  return (
    <div className="flex gap-2">
      <input type="number" step="0.1" min="0.1" value={xlm} onChange={(e) => setXlm(e.target.value)}
        placeholder="XLM" className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
      <button onClick={go} disabled={busy}
        className="rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50">
        {busy ? "…" : "Deposit"}
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
