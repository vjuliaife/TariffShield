"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";

type Step = "amount" | "preview" | "confirm" | "receipt";

export function DepositWizard({
  importerId,
  bucket,
  onDone,
  setError,
}: {
  importerId: string;
  bucket: "collateral" | "reserve";
  onDone: () => Promise<void>;
  setError: (e: string | null) => void;
}) {
  const [step, setStep] = useState<Step>("amount");
  const [xlm, setXlm] = useState("50");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDeposit() {
    setBusy(true);
    setError(null);
    try {
      const stroops = BigInt(Math.round(Number(xlm) * 1e7)).toString();
      const result = await api.deposit(importerId, { amountStroops: stroops, bucket });
      setTxHash(result.txHash);
      setStep("receipt");
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  }

  const bucketLabel = bucket === "collateral" ? "Collateral" : "Reserve (auto-top-up pool)";

  return (
    <div className="space-y-4">
      {step === "amount" && (
        <>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={xlm}
              onChange={(e) => setXlm(e.target.value)}
              placeholder="XLM"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <button
            onClick={() => setStep("preview")}
            className="w-full rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90"
          >
            Next
          </button>
        </>
      )}

      {step === "preview" && (
        <>
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="text-muted">Deposit amount</p>
            <p className="mt-1 text-lg font-semibold">{xlm} XLM</p>
            <p className="mt-2 text-xs text-muted">To: {bucketLabel}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("amount")}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
            >
              Back
            </button>
            <button
              onClick={() => setStep("confirm")}
              className="flex-1 rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90"
            >
              Confirm
            </button>
          </div>
        </>
      )}

      {step === "confirm" && (
        <>
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="font-semibold">Ready to deposit?</p>
            <p className="mt-2 text-xs text-muted">
              Sending {xlm} XLM to {bucketLabel.toLowerCase()}. This will be signed by your Stellar account.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep("preview")}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
            >
              Back
            </button>
            <button
              onClick={handleDeposit}
              disabled={busy}
              className="flex-1 rounded-md bg-success text-white px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Depositing…" : "Deposit"}
            </button>
          </div>
        </>
      )}

      {step === "receipt" && (
        <>
          <div className="rounded-lg border border-success bg-success/10 p-3 text-sm">
            <p className="font-semibold text-success">✓ Deposit successful</p>
            <p className="mt-2 text-xs text-muted">
              {xlm} XLM deposited to {bucketLabel.toLowerCase()}
            </p>
            {txHash && (
              <p className="mt-2 text-xs font-mono break-all text-accent">
                {txHash.slice(0, 16)}…
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
