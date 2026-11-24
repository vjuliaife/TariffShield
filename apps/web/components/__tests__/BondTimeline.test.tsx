import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ContractEvent } from '@/lib/api';
import { BondTimeline } from '../BondTimeline';

vi.mock('@/lib/api', () => ({
  api: {
    getEventAnnotations: vi.fn(),
    addAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
  },
}));

function makeEvent(id: string, kind: string, date: Date): ContractEvent {
  return {
    id,
    kind,
    amount: null,
    txHash: id,
    txUrl: null,
    createdAt: date.toISOString(),
  };
}

function monthEvent(id: string, kind: string, month: number, day: number, year = 2026) {
  return makeEvent(id, kind, new Date(year, month, day, 12));
}

function dayCells(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLDivElement>('div.min-h-20'));
}

function cellForDay(container: HTMLElement, day: number) {
  return dayCells(container).find((cell) => cell.querySelector('p')?.textContent === String(day));
}

describe('BondTimeline calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('dims adjacent-month dates and renders complete seven-day weeks', () => {
    const { container } = render(<BondTimeline events={[]} importerId="imp-1" />);
    const cells = dayCells(container);

    expect(cells).toHaveLength(35);
    expect(cells).toHaveLength(Math.floor(cells.length / 7) * 7);
    expect(cells.slice(0, 2).every((cell) => cell.className.includes('bg-muted/5'))).toBe(true);
    expect(cells.slice(2, 32).every((cell) => !cell.className.includes('bg-muted/5'))).toBe(true);
    expect(cells.slice(32).every((cell) => cell.className.includes('bg-muted/5'))).toBe(true);
  });

  it.each([
    { count: 2, more: null },
    { count: 3, more: '+1 more' },
    { count: 5, more: '+3 more' },
  ])('shows the first two events and the correct overflow for $count events', ({ count, more }) => {
    const kinds = ['deposit_first', 'yield_second', 'clawback_third', 'topup_fourth', 'deposit_fifth'];
    const events = kinds
      .slice(0, count)
      .map((kind, index) => monthEvent(`event-${index}`, kind, 8, 10));
    const { container } = render(<BondTimeline events={events} importerId="imp-1" />);
    const cell = cellForDay(container, 10);

    expect(cell).toBeDefined();
    const day = within(cell!);
    expect(day.getByRole('button', { name: /first/ })).toBeTruthy();
    expect(day.getByRole('button', { name: /second/ })).toBeTruthy();
    expect(day.queryByRole('button', { name: /third|fourth|fifth/ })).toBeNull();
    if (more) {
      expect(day.getByText(more)).toBeTruthy();
    } else {
      expect(day.queryByText(/\+\d+ more/)).toBeNull();
    }
  });

  it('updates the month label and event grid when navigating backward and forward', () => {
    const events = [
      monthEvent('september-event', 'deposit_september', 8, 10),
      monthEvent('october-event', 'yield_october', 9, 15),
    ];
    const { container } = render(<BondTimeline events={events} importerId="imp-1" />);

    expect(screen.getByText('September 2026')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '→' }));
    expect(screen.getByText('October 2026')).toBeTruthy();
    expect(screen.getByText('october')).toBeTruthy();
    expect(screen.queryByText('september')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '←' }));
    expect(screen.getByText('September 2026')).toBeTruthy();
    expect(screen.getByText('september')).toBeTruthy();
    expect(screen.queryByText('october')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '←' }));
    expect(screen.getByText('August 2026')).toBeTruthy();
    expect(dayCells(container)).toHaveLength(42);
  });

  it('rolls December navigation into January of the following year', () => {
    vi.setSystemTime(new Date(2026, 11, 15, 12));
    const events = [
      monthEvent('december-event', 'deposit_december', 11, 10),
      monthEvent('january-event', 'yield_january', 0, 15, 2027),
    ];
    const { container } = render(<BondTimeline events={events} importerId="imp-1" />);

    fireEvent.click(screen.getByRole('button', { name: '→' }));

    expect(screen.getByText('January 2027')).toBeTruthy();
    expect(screen.getByText('january')).toBeTruthy();
    expect(screen.queryByText('december')).toBeNull();
    expect(dayCells(container).length % 7).toBe(0);
  });

  it('maps event kinds to their color classes on day-cell chips', () => {
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
    const events = cases.map(([kind], index) =>
      monthEvent(`color-${index}`, kind, 8, index + 1),
    );

    render(<BondTimeline events={events} importerId="imp-1" />);

    for (const [kind, colorClass] of cases) {
      const chip = screen.getByTitle(`${kind} — click to view annotations`);
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.closest('.min-h-20')).toBeTruthy();
      expect(chip.className).toContain(colorClass);
    }
  });

  it('groups events on their createdAt calendar day, including just before midnight', () => {
    const beforeMidnight = makeEvent(
      'before-midnight',
      'before_midnight',
      new Date(2026, 8, 10, 23, 59, 59),
    );
    const events = [
      monthEvent('early', 'early_event', 8, 5),
      beforeMidnight,
      monthEvent('late', 'late_event', 8, 20),
    ];
    const { container } = render(<BondTimeline events={events} importerId="imp-1" />);

    for (const [kind, day] of [
      ['early_event', 5],
      ['before_midnight', 10],
      ['late_event', 20],
    ] as const) {
      const eventChip = screen.getByTitle(`${kind} — click to view annotations`);
      expect(eventChip.closest('.min-h-20')).toBe(cellForDay(container, day));
    }

    expect(cellForDay(container, 11)?.querySelectorAll('button')).toHaveLength(0);
    expect(cellForDay(container, 12)?.querySelectorAll('button')).toHaveLength(0);
  });
});
