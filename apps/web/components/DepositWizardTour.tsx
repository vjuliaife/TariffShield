'use client';

import { useEffect, useState } from 'react';
import { hasTourCompleted, markTourCompleted } from '@/lib/tour';

const TOUR_KEY = 'deposit-wizard';

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Deposit amount',
    body: 'Enter how much XLM to send. Collateral deposits count toward your required collateral; reserve deposits fund the auto-top-up pool used to cover shortfalls automatically.',
  },
  {
    title: 'Required collateral',
    body: '"Required collateral" is the minimum on-chain balance the surety needs, recalculated from your tariff exposure. Depositing here raises your posted collateral toward that requirement.',
  },
  {
    title: 'Auto-top-up threshold',
    body: 'If collateral ever falls short, "auto_top_up" moves funds from your reserve pool to cover the gap — reserve deposits are what make that automatic transfer possible.',
  },
];

// Issue #1033: renders as a small dismissible card alongside the wizard
// rather than a page-covering modal, so it never blocks or delays the
// underlying deposit form/submission.
export function useDepositWizardTour() {
  const [active, setActive] = useState(false);

  // First-time offer, unless already completed/dismissed.
  useEffect(() => {
    if (!hasTourCompleted(TOUR_KEY)) setActive(true);
  }, []);

  return {
    active,
    launch: () => setActive(true),
    close: () => {
      setActive(false);
      markTourCompleted(TOUR_KEY);
    },
  };
}

export function DepositWizardTour({ onClose }: { onClose: () => void }) {
  const [stepIdx, setStepIdx] = useState(0);
  const step = STEPS[stepIdx]!;
  const isLast = stepIdx === STEPS.length - 1;

  return (
    <div className="mb-3 rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-foreground">{step.title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close guided tour"
          className="text-muted hover:text-foreground shrink-0"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-muted">{step.body}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[10px] text-muted">
          Step {stepIdx + 1} of {STEPS.length}
        </span>
        <button
          type="button"
          onClick={() => (isLast ? onClose() : setStepIdx((i) => i + 1))}
          className="rounded bg-accent text-accent-foreground px-2 py-1 text-[11px] hover:opacity-90"
        >
          {isLast ? 'Done' : 'Next'}
        </button>
      </div>
    </div>
  );
}
