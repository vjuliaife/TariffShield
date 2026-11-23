// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthScore } from '@/components/HealthScore';

afterEach(cleanup);

function renderHealthScore(
  collateral: bigint,
  required: bigint,
  reserve: bigint,
  initialWarningThreshold?: number,
) {
  return render(
    <HealthScore
      collateral={collateral}
      required={required}
      reserve={reserve}
      initialWarningThreshold={initialWarningThreshold}
    />,
  );
}

function progressFill(container: HTMLElement, score: number): HTMLElement {
  const fill = container.querySelector<HTMLElement>(`[style*="width: ${score}%"]`);
  if (!fill) throw new Error(`progress fill for score ${score} not found`);
  return fill;
}

describe('Issue #652 — HealthScore Excellent grade boundary at exactly 80', () => {
  // coverage 80% * 0.7 + reserve 80% * 0.3 = 80 (no rounding involved)
  it('renders Excellent with success classes when the score computes to exactly 80', () => {
    const { container } = renderHealthScore(80n, 100n, 64n);

    expect(screen.getByText('80')).toBeTruthy();
    const badge = screen.getByText('Excellent');
    expect(badge.classList.contains('text-success')).toBe(true);
    expect(badge.classList.contains('bg-success/10')).toBe(true);
    expect(badge.classList.contains('text-accent')).toBe(false);
    expect(badge.classList.contains('bg-accent/10')).toBe(false);
    expect(progressFill(container, 80).classList.contains('bg-success')).toBe(true);
  });

  // coverage 100% * 0.7 + reserve 33% * 0.3 = 79.9, rounded to 80
  it('treats a score rounded up to 80 as Excellent', () => {
    const { container } = renderHealthScore(100n, 100n, 33n);

    expect(screen.getByText('80')).toBeTruthy();
    expect(screen.getByText('Excellent').classList.contains('text-success')).toBe(true);
    expect(progressFill(container, 80).classList.contains('bg-success')).toBe(true);
  });

  // coverage 100% * 0.7 + reserve 30% * 0.3 = 79
  it('renders Good with accent classes one point below the boundary', () => {
    renderHealthScore(100n, 100n, 30n);

    expect(screen.getByText('79')).toBeTruthy();
    expect(screen.queryByText('Excellent')).toBeNull();
    const badge = screen.getByText('Good');
    expect(badge.classList.contains('text-accent')).toBe(true);
    expect(badge.classList.contains('bg-accent/10')).toBe(true);
    expect(badge.classList.contains('text-success')).toBe(false);
  });

  it('keeps the grade Excellent but drops the bar out of bg-success when the warning threshold is above 80', () => {
    const { container } = renderHealthScore(80n, 100n, 64n, 85);

    expect(screen.getByText('Excellent').classList.contains('text-success')).toBe(true);
    const fill = progressFill(container, 80);
    expect(fill.classList.contains('bg-success')).toBe(false);
    expect(fill.classList.contains('bg-yellow-500')).toBe(true);
  });
});
