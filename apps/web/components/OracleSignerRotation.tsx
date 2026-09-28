'use client';

import { useState, useEffect } from 'react';

type SignerProposal = {
  id: string;
  proposed_by: string;
  new_signers: string[] | string;
  threshold: number;
  approvals: Array<{ approverId: string; approvedAt: string }>;
  status: 'proposed' | 'pending_signatures' | 'executed' | 'cancelled';
  tx_hash?: string;
  created_at: string;
};

export function OracleSignerRotation() {
  const [activeProposal, setActiveProposal] = useState<SignerProposal | null>(null);
  const [onChainSigners, setOnChainSigners] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [signer1, setSigner1] = useState('');
  const [signer2, setSigner2] = useState('');
  const [signer3, setSigner3] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/oracle-signers/active');
      if (!res.ok) throw new Error('Failed to fetch status');
      const data = await res.json();
      setActiveProposal(data.activeProposal);
      setOnChainSigners(data.onChainSigners || []);
    } catch {
      setError('Failed to load active signer rotation state.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handlePropose = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const newSigners = [signer1.trim(), signer2.trim(), signer3.trim()];
    if (newSigners.some((s) => s.length !== 56 || !s.startsWith('G'))) {
      setError('Each signer must be a valid 56-character Stellar G... address.');
      return;
    }
    if (new Set(newSigners).size !== 3) {
      setError('Signers must be 3 distinct addresses.');
      return;
    }

    setActionLoading(true);
    try {
      const res = await fetch('/api/admin/oracle-signers/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newSigners }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to propose rotation');
      }
      setSigner1('');
      setSigner2('');
      setSigner3('');
      await fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to submit proposal.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!activeProposal) return;
    setError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/oracle-signers/${activeProposal.id}/approve`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve');
      }
      await fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to record approval.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!activeProposal) return;
    setError(null);
    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/oracle-signers/${activeProposal.id}/execute`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to execute on-chain');
      }
      await fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to execute rotation on-chain.');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div className="p-4 text-sm text-muted">Loading Oracle Signer Rotation State...</div>;
  }

  const signersList = activeProposal
    ? typeof activeProposal.new_signers === 'string'
      ? JSON.parse(activeProposal.new_signers)
      : activeProposal.new_signers
    : [];

  const approvalCount = activeProposal?.approvals?.length ?? 0;
  const threshold = activeProposal?.threshold ?? 2;

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold text-foreground">Oracle Signer Rotation Workflow</h2>
        <p className="text-xs text-muted">
          Propose, track, and execute 2-of-3 multi-signature oracle signer updates on-chain.
        </p>
      </div>

      {error && (
        <div className="p-3 text-xs bg-danger/10 border border-danger/20 text-danger rounded-md">
          {error}
        </div>
      )}

      {/* Current On-Chain Signers */}
      <div className="bg-background/50 border border-border rounded-md p-4 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          Current On-Chain Oracle Signers
        </h3>
        {onChainSigners.length === 0 ? (
          <p className="text-xs text-muted italic">No signers returned or contract uninitialized.</p>
        ) : (
          <ul className="space-y-1 font-mono text-xs">
            {onChainSigners.map((s, idx) => (
              <li key={idx} className="text-foreground">
                {idx + 1}. {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Active Proposal Progress or Form */}
      {activeProposal ? (
        <div className="border border-border rounded-md p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="text-sm font-semibold text-foreground">Pending Signer Rotation Proposal</h3>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/10 text-accent font-medium">
              {approvalCount} / {threshold} Approvals
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <p className="text-muted font-medium">Proposed New Signers:</p>
            <ul className="space-y-1 font-mono text-foreground bg-card p-2 rounded border border-border">
              {signersList.map((addr: string, i: number) => (
                <li key={i}>
                  {i + 1}. {addr}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={actionLoading}
              onClick={handleApprove}
              className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
            >
              Sign & Approve Proposal
            </button>

            <button
              type="button"
              disabled={actionLoading || approvalCount < threshold}
              onClick={handleExecute}
              className="px-3 py-1.5 text-xs font-medium rounded bg-success text-success-foreground hover:opacity-90 disabled:opacity-50"
            >
              Execute Rotation On-Chain
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handlePropose} className="space-y-4">
          <h3 className="text-sm font-semibold text-foreground">Propose New Oracle Signer Set</h3>
          <div className="space-y-2">
            <input
              type="text"
              placeholder="Signer 1 Stellar Public Key (G...)"
              value={signer1}
              onChange={(e) => setSigner1(e.target.value)}
              className="w-full text-xs font-mono p-2 rounded border border-border bg-background"
              required
            />
            <input
              type="text"
              placeholder="Signer 2 Stellar Public Key (G...)"
              value={signer2}
              onChange={(e) => setSigner2(e.target.value)}
              className="w-full text-xs font-mono p-2 rounded border border-border bg-background"
              required
            />
            <input
              type="text"
              placeholder="Signer 3 Stellar Public Key (G...)"
              value={signer3}
              onChange={(e) => setSigner3(e.target.value)}
              className="w-full text-xs font-mono p-2 rounded border border-border bg-background"
              required
            />
          </div>
          <button
            type="submit"
            disabled={actionLoading}
            className="px-4 py-2 text-xs font-medium rounded bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {actionLoading ? 'Submitting...' : 'Submit Signer Rotation Proposal'}
          </button>
        </form>
      )}
    </div>
  );
}
