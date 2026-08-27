'use client';

import { CopyButton } from './CopyButton';

interface StellarTxWidgetProps {
  address: string;
  txHash?: string;
  label?: string;
}

export function StellarTxWidget({ address, txHash, label = 'stellar address' }: StellarTxWidgetProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        <CopyButton value={address} label={label} size="md" />
      </div>
      {txHash ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-muted">Transaction hash</span>
          <CopyButton value={txHash} label="transaction hash" size="sm" />
        </div>
      ) : null}
    </div>
  );
}

export default StellarTxWidget;
