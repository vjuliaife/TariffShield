'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Checklist = Awaited<ReturnType<typeof api.onboardingChecklist>>;
type Referrals = Awaited<ReturnType<typeof api.referrals>>;

export function ImporterSetupPanel() {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [referrals, setReferrals] = useState<Referrals | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void Promise.all([api.onboardingChecklist(), api.referrals()])
      .then(([steps, invites]) => {
        setChecklist(steps);
        setReferrals(invites);
      })
      .catch(() => undefined);
  }, []);

  if (!checklist && !referrals) return null;
  const shareUrl =
    referrals && typeof window !== 'undefined'
      ? `${window.location.origin}/signup?ref=${referrals.code}`
      : '';

  return (
    <section
      className="mt-8 grid gap-6 border-y border-border py-6 md:grid-cols-2"
      aria-label="Importer setup and referrals"
    >
      {checklist && !checklist.complete && !checklist.dismissed && !dismissed && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Getting started</h2>
            <button
              type="button"
              className="text-xs text-muted underline"
              onClick={() => void api.dismissOnboardingChecklist().then(() => setDismissed(true))}
            >
              Dismiss
            </button>
          </div>
          <ol className="mt-3 space-y-2">
            {checklist.steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-sm">
                <span aria-label={step.complete ? 'Complete' : 'Incomplete'}>
                  {step.complete ? '✓' : '○'}
                </span>
                {step.complete ? (
                  <span className="text-muted line-through">{step.label}</span>
                ) : (
                  <a className="text-accent hover:underline" href={step.href}>
                    {step.label}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {referrals && (
        <div>
          <h2 className="text-sm font-semibold">Importer referrals</h2>
          <p className="mt-2 text-xs text-muted">Your referral code</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="rounded border border-border px-2 py-1 text-sm">{referrals.code}</code>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
              onClick={() => void navigator.clipboard.writeText(shareUrl)}
            >
              Copy invite link
            </button>
          </div>
          <ul className="mt-3 space-y-1 text-xs">
            {referrals.referrals.length === 0 ? (
              <li className="text-muted">No sign-ups attributed yet.</li>
            ) : (
              referrals.referrals.map((referral) => (
                <li key={referral.id} className="flex justify-between gap-3">
                  <span>{referral.email}</span>
                  <span className="capitalize text-muted">{referral.status}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
