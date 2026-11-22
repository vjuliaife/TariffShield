import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ContractEvent } from '@/lib/api';
import { BondTimeline } from '../BondTimeline';

function makeEvent(kind: string, day: number): ContractEvent {
  return {
    id: `${kind}-${day}`,
    kind,
    amount: null,
    txHash: '',
    txUrl: null,
    createdAt: new Date(2026, 1, day, 12).toISOString(),
  };
}

function getDayCell(day: number): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.min-h-20')).find(
    (cell) =>
      cell.className.includes('bg-card') &&
      cell.querySelector('p')?.textContent === String(day),
  );
}

describe('BondTimeline event colors', () => {
  it('applies substring-matched event colors to day-cell chips, including the fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 15, 12));
    const cases = [
      ['deposit', 'bg-accent/20 text-accent'],
      ['yield', 'bg-success/20 text-success'],
      ['accrue', 'bg-success/20 text-success'],
      ['clawback', 'bg-danger/20 text-danger'],
      ['top-up', 'bg-yellow-500/20 text-yellow-600'],
      ['topup', 'bg-yellow-500/20 text-yellow-600'],
      ['auto_top-up_reserve', 'bg-yellow-500/20 text-yellow-600'],
      ['unknown_action', 'bg-muted/20 text-muted'],
    ] as const;

    render(
      <BondTimeline
        importerId="importer-1"
        events={cases.map(([kind], index) => makeEvent(kind, index + 1))}
      />,
    );

    for (const [kind, colorClass] of cases) {
      const chip = screen.getByTitle(`${kind} — click to view annotations`);
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.closest('.min-h-20')).toBeTruthy();
      expect(chip.className).toContain(colorClass);
    }
  });
});

describe('BondTimeline event dates', () => {
  it('groups events by their local createdAt day, including just before midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 15, 12));
    const beforeMidnight = makeEvent('before_midnight', 10);
    beforeMidnight.createdAt = new Date(2026, 1, 10, 23, 59, 59).toISOString();
    const events = [makeEvent('early_event', 5), beforeMidnight, makeEvent('late_event', 20)];

    render(<BondTimeline importerId="importer-1" events={events} />);

    for (const [kind, day] of [
      ['early_event', 5],
      ['before_midnight', 10],
      ['late_event', 20],
    ] as const) {
      const eventChip = screen.getByTitle(`${kind} — click to view annotations`);
      expect(eventChip.closest('.min-h-20')).toBe(getDayCell(day));
    }

    expect(getDayCell(11)?.querySelectorAll('button')).toHaveLength(0);
    expect(getDayCell(12)?.querySelectorAll('button')).toHaveLength(0);
  });
});
