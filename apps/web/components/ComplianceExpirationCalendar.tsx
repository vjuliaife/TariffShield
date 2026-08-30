'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api, type ComplianceExpirationItem } from '@/lib/api';

export function ComplianceExpirationCalendar({ importerId }: { importerId: string }) {
  const [items, setItems] = useState<ComplianceExpirationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedItem, setSelectedItem] = useState<ComplianceExpirationItem | null>(null);

  useEffect(() => {
    async function loadCalendar() {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getComplianceCalendar(importerId);
        setItems(res.items);
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Failed to load document expiration calendar'
        );
      } finally {
        setLoading(false);
      }
    }
    loadCalendar();
  }, [importerId]);

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - firstDay.getDay());

  // Group expirations by date
  const expirationsByDate: Record<string, ComplianceExpirationItem[]> = {};
  items.forEach((item) => {
    const d = new Date(item.expirationDate);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!expirationsByDate[key]) expirationsByDate[key] = [];
    expirationsByDate[key].push(item);
  });

  const getUrgencyColor = (urgency: string) => {
    switch (urgency) {
      case 'critical':
        return 'bg-danger/20 text-danger border-danger/40';
      case 'warning':
        return 'bg-yellow-500/20 text-yellow-600 border-yellow-500/40';
      case 'upcoming':
        return 'bg-blue-500/20 text-blue-600 border-blue-500/40';
      default:
        return 'bg-muted/20 text-muted border-border';
    }
  };

  const getUrgencyBadge = (days: number) => {
    if (days <= 30) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-danger text-white">
          Expires in {days}d (Critical)
        </span>
      );
    }
    if (days <= 60) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-yellow-500 text-black">
          Expires in {days}d (Warning)
        </span>
      );
    }
    if (days <= 90) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-500 text-white">
          Expires in {days}d (Upcoming)
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-foreground">
        Expires in {days}d
      </span>
    );
  };

  const weeks: Date[][] = [];
  let week: Date[] = [];
  const d = new Date(startDate);

  while (d <= lastDay || week.length > 0) {
    week.push(new Date(d));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
    d.setDate(d.getDate() + 1);
    if (d > lastDay && week.length > 0) {
      weeks.push(week);
      break;
    }
  }

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1));
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1));

  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center animate-pulse">
        <div className="h-4 w-48 bg-muted rounded mx-auto mb-4" />
        <div className="h-64 bg-muted/20 rounded" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Compliance & Document Expirations
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Consolidated expiration calendar for KYC documents and surety licenses.
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-danger" /> &le;30 Days
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" /> 31-60 Days
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> 61-90 Days
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <svg
            className="w-10 h-10 text-muted mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.5"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="text-sm font-medium">No Tracked Expirations Found</h3>
          <p className="mt-1 text-xs text-muted max-w-sm mx-auto">
            All compliance documents and surety licenses are up to date with no upcoming expiration
            dates.
          </p>
        </div>
      ) : (
        <>
          {/* Month Header Navigation */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-sm">
              {monthNames[month]} {year}
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={prevMonth}
                className="p-1 rounded hover:bg-muted/30 text-muted hover:text-foreground text-sm font-bold"
                aria-label="Previous month"
              >
                &larr;
              </button>
              <button
                onClick={() => setCurrentMonth(new Date())}
                className="px-2 py-1 text-xs rounded border border-border hover:bg-muted/20"
              >
                Today
              </button>
              <button
                onClick={nextMonth}
                className="p-1 rounded hover:bg-muted/30 text-muted hover:text-foreground text-sm font-bold"
                aria-label="Next month"
              >
                &rarr;
              </button>
            </div>
          </div>

          {/* Calendar Grid */}
          <div className="border border-border rounded-lg overflow-hidden bg-background">
            <div className="grid grid-cols-7 border-b border-border text-center text-xs font-medium text-muted bg-muted/20 py-2">
              <span>Sun</span>
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
            </div>

            <div className="divide-y divide-border">
              {weeks.map((wk, wIdx) => (
                <div key={wIdx} className="grid grid-cols-7 divide-x divide-border min-h-[90px]">
                  {wk.map((day, dIdx) => {
                    const isCurrMonth = day.getMonth() === month;
                    const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
                    const dayItems = expirationsByDate[dateKey] || [];
                    const isToday = new Date().toDateString() === day.toDateString();

                    return (
                      <div
                        key={dIdx}
                        className={`p-1.5 transition-colors flex flex-col justify-between ${
                          !isCurrMonth ? 'bg-muted/5 opacity-40' : ''
                        } ${isToday ? 'bg-accent/5' : ''}`}
                      >
                        <div className="flex justify-between items-center mb-1">
                          <span
                            className={`text-xs font-mono rounded px-1 ${
                              isToday ? 'bg-accent text-accent-foreground font-bold' : 'text-muted'
                            }`}
                          >
                            {day.getDate()}
                          </span>
                        </div>

                        <div className="flex flex-col gap-1 overflow-y-auto max-h-20">
                          {dayItems.map((item) => (
                            <button
                              key={item.id}
                              onClick={() => setSelectedItem(item)}
                              className={`text-left text-[10px] px-1.5 py-0.5 rounded border truncate transition-opacity hover:opacity-80 font-medium ${getUrgencyColor(
                                item.urgency
                              )}`}
                              title={`${item.title} (Expires in ${item.daysUntilExpiration} days)`}
                            >
                              {item.title}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Selected Item Modal / Details Box with Deep Link */}
          {selectedItem && (
            <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4 animate-fadeIn">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-semibold text-sm">{selectedItem.title}</h4>
                    {getUrgencyBadge(selectedItem.daysUntilExpiration)}
                  </div>
                  <p className="text-xs text-muted mt-1">
                    Expiration Date: {new Date(selectedItem.expirationDate).toLocaleDateString()} (
                    {selectedItem.daysUntilExpiration} days remaining)
                  </p>
                </div>
                <button
                  onClick={() => setSelectedItem(null)}
                  className="text-xs text-muted hover:text-foreground"
                >
                  &times; Close
                </button>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <Link
                  href={selectedItem.deepLink}
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  Go to Document Renewal / Upload Flow &rarr;
                </Link>
              </div>
            </div>
          )}

          {/* List View of All Upcoming Expirations */}
          <div className="mt-6">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">
              Upcoming Expirations ({items.length})
            </h4>
            <div className="divide-y divide-border border border-border rounded-lg overflow-hidden bg-background">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="p-3 flex items-center justify-between hover:bg-muted/10 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        item.urgency === 'critical'
                          ? 'bg-danger'
                          : item.urgency === 'warning'
                            ? 'bg-yellow-500'
                            : item.urgency === 'upcoming'
                              ? 'bg-blue-500'
                              : 'bg-muted'
                      }`}
                    />
                    <div>
                      <p className="text-xs font-medium text-foreground">{item.title}</p>
                      <p className="text-[11px] text-muted font-mono">
                        Expires {new Date(item.expirationDate).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {getUrgencyBadge(item.daysUntilExpiration)}
                    <Link
                      href={item.deepLink}
                      className="text-xs text-accent hover:underline font-medium"
                    >
                      Renew / Upload &rarr;
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
