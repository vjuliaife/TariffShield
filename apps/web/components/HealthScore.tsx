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
  importerId,
  initialWarningThreshold = 60,
  initialCriticalThreshold = 40,
}: {
  collateral: bigint;
  required: bigint;
  reserve: bigint;
  importerId?: string;
  initialWarningThreshold?: number;
  initialCriticalThreshold?: number;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [warningThreshold, setWarningThreshold] = useState(initialWarningThreshold);
  const [criticalThreshold, setCriticalThreshold] = useState(initialCriticalThreshold);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

  const handleSaveThresholds = async () => {
    if (criticalThreshold >= warningThreshold) {
      setErrorMsg('Critical threshold must be strictly less than Warning threshold.');
      return;
    }
    setErrorMsg(null);
    setSaving(true);
    try {
      if (importerId) {
        await fetch(`/api/notifications/thresholds/${importerId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ warningThreshold, criticalThreshold }),
        });
      }
      setShowSettings(false);
    } catch {
      setErrorMsg('Failed to save threshold settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
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
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          aria-label="Configure Alert Thresholds"
          className="text-xs text-muted hover:text-foreground underline"
        >
          ⚙ Alert Thresholds
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
        </div>
      )}

      {showSettings && (
        <div className="mt-3 text-xs text-muted bg-background/50 border border-border rounded-md p-3 space-y-3">
          <p className="font-semibold text-foreground">Configure Alert Thresholds</p>
          {errorMsg && <p className="text-danger text-[11px] font-medium">{errorMsg}</p>}
          <div className="space-y-2">
            <div>
              <label className="block text-foreground font-medium mb-1">
                Warning Threshold: {warningThreshold}
              </label>
              <input
                type="range"
                min="1"
                max="100"
                value={warningThreshold}
                onChange={(e) => setWarningThreshold(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-foreground font-medium mb-1">
                Critical Threshold: {criticalThreshold}
              </label>
              <input
                type="range"
                min="0"
                max="99"
                value={criticalThreshold}
                onChange={(e) => setCriticalThreshold(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="px-2 py-1 rounded border border-border hover:bg-muted/10 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveThresholds}
              className="px-2 py-1 rounded bg-accent text-accent-foreground font-medium text-xs hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
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
        <div className="relative h-2 bg-border rounded overflow-hidden">
          <div
            className={`h-full transition-all ${
              healthScore >= warningThreshold
                ? 'bg-success'
                : healthScore >= criticalThreshold
                  ? 'bg-yellow-500'
                  : 'bg-danger'
            }`}
            style={{ width: `${healthScore}%` }}
          />
        </div>

        <div className="flex justify-between text-[10px] text-muted font-medium">
          <span>Critical Alert: &lt; {criticalThreshold}</span>
          <span>Warning Alert: &lt; {warningThreshold}</span>
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
        <PeerBenchmarkIndicator importerId={importerId} />
      </div>
    </div>
  );
}

interface PeerBenchmarkData {
  suppressed: boolean;
  reason?: string;
  cohort?: {
    sizeCohort: string;
    memberCount: number;
  };
  percentile?: number;
  medianScore?: number;
}

export function PeerBenchmarkIndicator({ importerId }: { importerId?: string }) {
  const [benchmark, setBenchmark] = useState<PeerBenchmarkData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!importerId) return;
    setLoading(true);
    fetch(`/api/importers/${importerId}/peer-benchmark`)
      .then((res) => res.json())
      .then((data) => setBenchmark(data))
      .catch(() => setBenchmark(null))
      .finally(() => setLoading(false));
  }, [importerId]);

  if (loading || !benchmark) return null;

  if (benchmark.suppressed) {
    return (
      <div className="mt-2 text-[10px] text-muted italic">
        Peer benchmark suppressed (cohort size &lt; 5 for privacy).
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md bg-accent/5 border border-accent/20 p-2.5 text-xs flex items-center justify-between">
      <div>
        <span className="font-semibold text-foreground">Peer Benchmark:</span>{' '}
        <span className="text-accent font-bold">{benchmark.percentile}th Percentile</span>
        <span className="text-muted text-[10px] block">
          Compared to {benchmark.cohort?.memberCount} peers in {benchmark.cohort?.sizeCohort} cohort
        </span>
      </div>
      <div className="text-right text-[10px] text-muted">
        Median: <span className="font-semibold text-foreground">{benchmark.medianScore} pts</span>
      </div>
    </div>
  );
}


