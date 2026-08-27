'use client';

import { useEffect, useState } from 'react';

type HealthGrade = {
  grade: 'excellent' | 'good' | 'fair' | 'poor';
  gradeColor: string;
};

function getHealthGrade(healthScore: number): HealthGrade {
  if (healthScore >= 80) {
    return { grade: 'excellent', gradeColor: 'text-success bg-success/10' };
  }

  if (healthScore >= 60) {
    return { grade: 'good', gradeColor: 'text-accent bg-accent/10' };
  }

  if (healthScore >= 40) {
    return { grade: 'fair', gradeColor: 'text-yellow-500 bg-yellow-500/10' };
  }

  return { grade: 'poor', gradeColor: 'text-danger bg-danger/10' };
}
export function HealthScore({
  collateral,
  required,
  reserve,
}: {
  collateral: bigint;
  required: bigint;
  reserve: bigint;
}) {
  const [showInfo, setShowInfo] = useState(false);

  const coverageRatio = required === 0n ? 100 : Number((collateral * 100n) / required);
  const reserveRatio = collateral === 0n ? 0 : Number((reserve * 100n) / collateral);

  const coverageScore = Math.min(100, coverageRatio);
  const reserveScore = Math.min(100, Math.max(0, reserveRatio));

  const healthScore = Math.round(coverageScore * 0.7 + reserveScore * 0.3);

  const { grade } = getHealthGrade(healthScore);
  const [displayedScore, setDisplayedScore] = useState(healthScore);
  const [displayedGrade, setDisplayedGrade] = useState(grade);
  const [scoreVisible, setScoreVisible] = useState(true);
  const { gradeColor: displayedGradeColor } = getHealthGrade(displayedScore);

  useEffect(() => {
    if (displayedScore === healthScore && displayedGrade === grade) return;

    setScoreVisible(false);
    const timer = window.setTimeout(() => {
      setDisplayedScore(healthScore);
      setDisplayedGrade(grade);
      setScoreVisible(true);
    }, 150);

    return () => window.clearTimeout(timer);
  }, [displayedGrade, displayedScore, grade, healthScore]);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5">
        <p className="text-xs uppercase tracking-wide text-muted">Account Health Score</p>
        <button
          type="button"
          onClick={() => setShowInfo(!showInfo)}
          aria-label="Account Health Score breakdown formula and grade thresholds"
          className="inline-flex items-center justify-center text-muted hover:text-foreground focus:outline-none text-xs rounded-full w-4 h-4 border border-muted/40 hover:border-foreground"
        >
          ⓘ
        </button>
      </div>

      {showInfo && (
        <div className="mt-3 text-xs text-muted bg-background/50 border border-border rounded-md p-3 space-y-2">
          <p className="font-semibold text-foreground">How Health Score is Calculated</p>
          <p>The score (0–100) is a weighted combination of your collateral ratios:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>
              <span className="font-medium text-foreground">70% Coverage Ratio</span>: Collateral ÷
              Required (capped at 100%)
            </li>
            <li>
              <span className="font-medium text-foreground">30% Reserve Ratio</span>: Reserve ÷
              Collateral (capped at 100%)
            </li>
          </ul>
          <p className="font-semibold text-foreground pt-1">Grade Thresholds</p>
          <ul className="grid grid-cols-2 gap-1 text-[11px]">
            <li>
              <span className="text-success font-medium">Excellent</span>: 80–100
            </li>
            <li>
              <span className="text-accent font-medium">Good</span>: 60–79
            </li>
            <li>
              <span className="text-yellow-500 font-medium">Fair</span>: 40–59
            </li>
            <li>
              <span className="text-danger font-medium">Poor</span>: &lt; 40
            </li>
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <div>
          <p
            aria-live="polite"
            className={`min-w-[3ch] tabular-nums text-4xl font-bold transition-opacity duration-150 ease-out ${
              scoreVisible ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {displayedScore}
          </p>
          <p
            className={`mt-1 min-w-20 rounded px-2 py-1 text-center text-sm font-semibold transition-opacity duration-150 ease-out ${displayedGradeColor} ${
              scoreVisible ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {displayedGrade.charAt(0).toUpperCase() + displayedGrade.slice(1)}
          </p>
        </div>
        <div className="text-right text-xs text-muted space-y-0.5">
          <p>
            Coverage (70% weight):{' '}
            <span className="font-semibold text-foreground">{coverageRatio.toFixed(0)}%</span>
          </p>
          <p>
            Reserve (30% weight):{' '}
            <span className="font-semibold text-foreground">{reserveRatio.toFixed(0)}%</span>
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        <div className="h-2 bg-border rounded overflow-hidden">
          <div
            className={`h-full transition-all ${
              healthScore >= 80
                ? 'bg-success'
                : healthScore >= 60
                  ? 'bg-accent'
                  : healthScore >= 40
                    ? 'bg-yellow-500'
                    : 'bg-danger'
            }`}
            style={{ width: `${healthScore}%` }}
          />
        </div>

        {/* Component breakdown showing contribution to the score */}
        <div className="grid grid-cols-2 gap-3 text-[10px] text-muted">
          <div>
            <div className="flex justify-between mb-1">
              <span>Coverage Contribution</span>
              <span className="font-semibold text-foreground">
                {(coverageScore * 0.7).toFixed(1)} pts
              </span>
            </div>
            <div className="h-1 bg-border rounded overflow-hidden">
              <div className="h-full bg-success/80" style={{ width: `${coverageScore}%` }} />
            </div>
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <span>Reserve Contribution</span>
              <span className="font-semibold text-foreground">
                {(reserveScore * 0.3).toFixed(1)} pts
              </span>
            </div>
            <div className="h-1 bg-border rounded overflow-hidden">
              <div className="h-full bg-accent/80" style={{ width: `${reserveScore}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
