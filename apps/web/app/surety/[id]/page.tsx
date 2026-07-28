"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Nav } from "@/components/Nav";
import { api, ApiError, type ImporterDetail, type ContractEvent, stroopsToXlm } from "@/lib/api";
import { getUser, isAuthenticated } from "@/lib/auth";

export default function SuretyImporterDetail() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<ImporterDetail | null>(null);
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [yieldXlm, setYieldXlm] = useState("1");

  const refresh = useCallback(async () => {
    if (!params?.id) return;
    try {
      const d = await api.getImporter(params.id);
      setDetail(d);
      // #255: events are no longer inlined into getImporter() — fetch the
      // first page from the cursor-paginated endpoint instead.
      const page = await api.getImporterEventsCursor(params.id);
      setEvents(page.events);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }, [params?.id]);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/login"); return; }
    const user = getUser();
    if (user?.role !== "surety_admin") { router.replace("/app"); return; }
    refresh();
  }, [router, refresh]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(null); }
  }

  if (!detail) return (<><Nav /><main className="max-w-4xl mx-auto px-6 py-10"><p className="text-muted">Loading…</p></main></>);

  const onc = detail.onChainAccount;
  const totalAtRisk = BigInt(onc.collateralBalance) + BigInt(onc.reserveBalance);

  return (
    <>
      <Nav />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <Link href="/surety" className="text-sm text-accent hover:underline">← Back to portfolio</Link>

        <div className="mt-4">
          <h1 className="text-2xl font-semibold">{detail.importer.legalName}</h1>
          <p className="mt-1 text-sm text-muted">Bond <span className="font-mono">{detail.importer.bondId}</span></p>
          <p className="mt-1 text-xs font-mono break-all text-muted">{detail.importer.stellarAddress}</p>
        </div>

        {onc.isClawbacked ? (
          <div className="mt-6 rounded-lg border border-danger bg-danger/10 px-4 py-3 text-sm">
            <strong className="text-danger">Account frozen.</strong> Clawback already executed.
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Collateral</p>
            <p className="mt-1 text-xl font-semibold font-mono">{stroopsToXlm(onc.collateralBalance)} XLM</p>
            <p className="mt-1 text-xs text-muted">Required: <span className="font-mono">{stroopsToXlm(onc.requiredCollateral)}</span></p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">Reserve (auto-top-up pool)</p>
            <p className="mt-1 text-xl font-semibold font-mono">{stroopsToXlm(onc.reserveBalance)} XLM</p>
            <p className="mt-1 text-xs text-muted">Yield accrued: <span className="font-mono">{stroopsToXlm(onc.yieldAccrued)}</span></p>
          </div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Accrue simulated BENJI yield</h2>
            <p className="mt-1 text-xs text-muted">Records yield on-chain. Mainnet wires this to real T-bill fund flow.</p>
            <div className="mt-3 flex gap-2">
              <input type="number" step="0.01" min="0.01" value={yieldXlm} onChange={(e) => setYieldXlm(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none" />
              <button
                disabled={busy !== null || onc.isClawbacked}
                onClick={() =>
                  act("yield", () =>
                    api.accrueYield(detail.importer.id, {
                      amountStroops: (BigInt(Math.round(Number(yieldXlm) * 1e7))).toString(),
                    }),
                  )
                }
                className="rounded-md border border-accent text-accent px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
              >
                {busy === "yield" ? "…" : "Accrue"}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-danger/40 bg-danger/5 p-4">
            <h2 className="text-sm font-semibold text-danger">Emergency clawback</h2>
            <p className="mt-1 text-xs text-muted">
              Drains <span className="font-mono">{stroopsToXlm(totalAtRisk.toString())} XLM</span> (collateral + reserve) to surety wallet + freezes account.
              Use on importer default.
            </p>
            <button
              disabled={busy !== null || onc.isClawbacked || totalAtRisk === 0n}
              onClick={() => act("clawback", () => api.clawback(detail.importer.id))}
              className="mt-3 rounded-md bg-danger text-white px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy === "clawback" ? "Executing clawback on-chain…" :
               onc.isClawbacked ? "Already clawed back" :
               totalAtRisk === 0n ? "No funds to claw back" :
               "Clawback now"}
            </button>
          </div>
        </div>

        {error ? <p className="mt-4 rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">On-chain event log</h2>
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
