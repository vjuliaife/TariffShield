'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';
import { DepositWizardTour, useDepositWizardTour } from './DepositWizardTour';

type Step = 'amount' | 'preview' | 'confirm' | 'receipt';

export function DepositWizard({
  importerId,
  bucket,
  onDone,
  onCancel,
  setError,
}: {
  importerId: string;
  bucket: 'collateral' | 'reserve';
  onDone: () => Promise<void>;
  onCancel?: () => void;
  setError: (e: FormattedError | string | null) => void;
}) {
  const [step, setStep] = useState<Step>('amount');
  const [xlm, setXlm] = useState('50');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tour = useDepositWizardTour();

  function resetWizard() {
    setStep('amount');
    setXlm('50');
    setTxHash(null);
    setBusy(false);
  }

  function handleCancel() {
    resetWizard();
    onCancel?.();
  }

  async function handleDeposit() {
    setBusy(true);
    setError(null);
    try {
      const stroops = BigInt(Math.round(Number(xlm) * 1e7)).toString();
      const result = await api.deposit(importerId, { amountStroops: stroops, bucket });
      setTxHash(result.txHash);
      setStep('receipt');
      await onDone();
    } catch (e) {
      setError(formatApiError(e));
      setBusy(false);
    }
  }

  const bucketLabel = bucket === 'collateral' ? 'Collateral' : 'Reserve (auto-top-up pool)';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end -mb-2">
        <button
          type="button"
          onClick={tour.launch}
          aria-label="Show guided tour for this form"
          title="Show guided tour"
          className="inline-flex items-center justify-center text-muted hover:text-foreground text-xs rounded-full w-4 h-4 border border-muted/40 hover:border-foreground"
        >
          ?
        </button>
      </div>
      {tour.active && <DepositWizardTour onClose={tour.close} />}

      {step === 'amount' && (
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
            onClick={() => setStep('preview')}
            className="w-full rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90"
          >
            Next
          </button>
        </>
      )}

      {step === 'preview' && (
        <>
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="text-muted">Deposit amount</p>
            <p className="mt-1 text-lg font-semibold">{xlm} XLM</p>
            <p className="mt-2 text-xs text-muted">To: {bucketLabel}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCancel}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
            >
              Cancel
            </button>
            <button
              onClick={() => setStep('confirm')}
              className="flex-1 rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90"
            >
              Confirm
            </button>
          </div>
        </>
      )}

      {step === 'confirm' && (
        <>
          <div className="rounded-lg border border-border bg-background p-3 text-sm">
            <p className="font-semibold">Ready to deposit?</p>
            <p className="mt-2 text-xs text-muted">
              Sending {xlm} XLM to {bucketLabel.toLowerCase()}. This will be signed by your Stellar
              account.
            </p>
          </div>
          <div className="flex gap-2">
            {!busy && (
              <button
                onClick={handleCancel}
                className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleDeposit}
              disabled={busy}
              className="flex-1 rounded-md bg-success text-white px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Depositing…' : 'Deposit'}
            </button>
          </div>
        </>
      )}

      {step === 'receipt' && (
        <>
          <div className="rounded-lg border border-success bg-success/10 p-3 text-sm">
            <p className="font-semibold text-success">✓ Deposit successful</p>
            <p className="mt-2 text-xs text-muted">
              {xlm} XLM deposited to {bucketLabel.toLowerCase()}
            </p>
            {txHash && (
              <p className="mt-2 text-xs font-mono break-all text-accent">{txHash.slice(0, 16)}…</p>
            )}
          </div>
          {/* #1049 — the receipt is no longer a dead end: the user can start
              another deposit (state reset to the amount step, clearing the
              previous txHash) or dismiss the wizard entirely. */}
          <div className="flex gap-2">
            <button
              onClick={resetWizard}
              className="flex-1 rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-sm hover:opacity-90"
            >
              Make another deposit
            </button>
            <button
              onClick={handleCancel}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-card"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
