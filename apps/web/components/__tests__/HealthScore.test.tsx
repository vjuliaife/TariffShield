import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthScore } from '../HealthScore';

describe('HealthScore progress width', () => {
  it.each([
    { name: '91%', collateral: 100n, required: 100n, reserve: 70n, score: 91 },
    { name: '72.5 rounds to 73%', collateral: 65n, required: 100n, reserve: 59n, score: 73 },
    { name: '28%', collateral: 40n, required: 100n, reserve: 0n, score: 28 },
  ])(
    'matches the displayed rounded score of $name',
    ({ collateral, required, reserve, score }) => {
      const { container } = render(
        <HealthScore collateral={collateral} required={required} reserve={reserve} />,
      );

      expect(screen.getByText(String(score), { selector: 'p' })).toBeTruthy();
      expect(container.querySelector('.relative.h-2 > div')?.getAttribute('style')).toBe(
        `width: ${score}%;`,
      );
    },
  );

  it('caps the progress width at 100% for maximal coverage and reserve', () => {
    const { container } = render(
      <HealthScore collateral={200n} required={100n} reserve={200n} />,
    );

    expect(screen.getByText('100', { selector: 'p' })).toBeTruthy();
    expect(container.querySelector('.relative.h-2 > div')?.getAttribute('style')).toBe(
      'width: 100%;',
    );
  });
});
