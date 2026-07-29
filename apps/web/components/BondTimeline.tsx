"use client";

import { useState } from "react";
import { type ContractEvent } from "@/lib/api";

export function BondTimeline({ events }: { events: ContractEvent[] }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - firstDay.getDay());

  const eventsByDate: Record<string, ContractEvent[]> = {};
  events.forEach((e) => {
    const d = new Date(e.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(e);
  });

  const getEventColor = (kind: string) => {
    if (kind.includes("deposit")) return "bg-accent/20 text-accent";
    if (kind.includes("yield") || kind.includes("accrue")) return "bg-success/20 text-success";
    if (kind.includes("clawback")) return "bg-danger/20 text-danger";
    if (kind.includes("top-up") || kind.includes("topup")) return "bg-yellow-500/20 text-yellow-600";
    return "bg-muted/20 text-muted";
  };

  const weeks = [];
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

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Bond Timeline</h2>
        <div className="flex gap-2">
          <button onClick={prevMonth} className="text-xs px-2 py-1 border border-border rounded hover:bg-card">←</button>
          <span className="text-xs font-medium min-w-32 text-center">
            {firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </span>
          <button onClick={nextMonth} className="text-xs px-2 py-1 border border-border rounded hover:bg-card">→</button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-7 bg-muted/10">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
            <div key={day} className="p-2 text-xs font-semibold text-center text-muted">
              {day}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-px bg-border p-px">
          {weeks.map((week, wi) =>
            week.map((date, di) => {
              const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
              const dayEvents = eventsByDate[key] || [];
              const isCurrentMonth = date.getMonth() === month;

              return (
                <div
                  key={`${wi}-${di}`}
                  className={`min-h-20 p-2 text-xs ${isCurrentMonth ? "bg-card" : "bg-muted/5 text-muted/50"}`}
                >
                  <p className="font-semibold">{date.getDate()}</p>
                  <div className="mt-1 space-y-0.5">
                    {dayEvents.slice(0, 2).map((e) => (
                      <div
                        key={e.id}
                        className={`px-1 py-0.5 rounded text-xs truncate font-medium ${getEventColor(e.kind)}`}
                        title={e.kind}
                      >
                        {e.kind.split("_").pop()}
                      </div>
                    ))}
                    {dayEvents.length > 2 && (
                      <div className="text-xs text-muted px-1">+{dayEvents.length - 2} more</div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {events.length > 0 && (
        <div className="mt-4 text-xs text-muted">
          <p>Legend:</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-accent/20"></div>
              <span>Deposit</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-success/20"></div>
              <span>Yield</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-danger/20"></div>
              <span>Clawback</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-yellow-500/20"></div>
              <span>Top-up</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
