'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Issue #1035 — lightweight in-app NPS/feedback survey. Cadence is
// server-controlled (GET /nps/prompt-status), so this never shows on every
// login. Rendered as a small, fixed, non-modal card that a caller can
// additionally suppress during an in-progress deposit/withdrawal flow.
export function NpsSurvey() {
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .npsPromptStatus()
      .then((r) => {
        if (!cancelled && r.shouldShow) setVisible(true);
      })
      .catch(() => {
        // Silently skip the survey if the status check fails — it's non-critical.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  async function dismiss() {
    setVisible(false);
    try {
      await api.npsDismiss();
    } catch {
      // Best-effort: the survey stays dismissed for this session regardless.
    }
  }

  async function submit() {
    if (score === null) return;
    setBusy(true);
    try {
      await api.npsRespond(score, comment.trim() || undefined);
    } catch {
      // Best-effort: still show the thank-you state either way.
    } finally {
      setBusy(false);
      setDone(true);
      window.setTimeout(() => setVisible(false), 2500);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-4 shadow-xl">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss survey"
        className="absolute top-2 right-2 text-muted hover:text-foreground text-xs"
      >
        ✕
      </button>

      {done ? (
        <p className="text-sm text-success font-medium">Thanks for the feedback! 🙌</p>
      ) : (
        <>
          <p className="text-sm font-semibold pr-4">
            How likely are you to recommend TariffShield to another importer?
          </p>
          <div className="mt-3 grid grid-cols-11 gap-1">
            {Array.from({ length: 11 }, (_, n) => n).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setScore(n)}
                className={`rounded border py-1 text-xs hover:bg-accent hover:text-accent-foreground hover:border-accent ${score === n ? 'bg-accent text-accent-foreground border-accent' : 'border-border'}`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted">
            <span>Not likely</span>
            <span>Very likely</span>
          </div>

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Anything you'd like to add? (optional)"
            className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={dismiss}
              className="flex-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-background"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || score === null}
              className="flex-1 rounded-md bg-accent text-accent-foreground px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
