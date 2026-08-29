'use client';

import { useState, useEffect, useRef } from 'react';
import { type ContractEvent, type BondAnnotation, api } from '@/lib/api';

export function BondTimeline({
  events,
  importerId,
  userRole,
}: {
  events: ContractEvent[];
  importerId: string;
  userRole?: 'importer' | 'surety_admin';
}) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedEvent, setSelectedEvent] = useState<ContractEvent | null>(null);
  const [annotations, setAnnotations] = useState<BondAnnotation[]>([]);
  const [newNote, setNewNote] = useState('');
  const [loadingAnnotations, setLoadingAnnotations] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

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
    if (kind.includes('deposit')) return 'bg-accent/20 text-accent';
    if (kind.includes('yield') || kind.includes('accrue')) return 'bg-success/20 text-success';
    if (kind.includes('clawback')) return 'bg-danger/20 text-danger';
    if (kind.includes('top-up') || kind.includes('topup'))
      return 'bg-yellow-500/20 text-yellow-600';
    return 'bg-muted/20 text-muted';
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

  const handleEventClick = async (event: ContractEvent) => {
    if (selectedEvent?.id === event.id) {
      setSelectedEvent(null);
      setAnnotations([]);
      return;
    }
    setSelectedEvent(event);
    setLoadingAnnotations(true);
    try {
      const result = await api.getEventAnnotations(event.id);
      setAnnotations(result.annotations);
    } catch {
      setAnnotations([]);
    } finally {
      setLoadingAnnotations(false);
    }
  };

  const handleAddAnnotation = async () => {
    if (!newNote.trim() || !selectedEvent) return;
    try {
      const result = await api.addAnnotation({
        event_id: selectedEvent.id,
        importer_id: importerId,
        note: newNote.trim(),
      });
      setAnnotations([result.annotation, ...annotations]);
      setNewNote('');
    } catch {
      // silently fail
    }
  };

  const handleUpdateAnnotation = async (id: string) => {
    if (!editNote.trim()) return;
    try {
      const result = await api.updateAnnotation(id, editNote.trim());
      setAnnotations(annotations.map((a) => (a.id === id ? result.annotation : a)));
      setEditingId(null);
      setEditNote('');
    } catch {
      // silently fail
    }
  };

  const handleDeleteAnnotation = async (id: string) => {
    try {
      await api.deleteAnnotation(id);
      setAnnotations(annotations.filter((a) => a.id !== id));
    } catch {
      // silently fail
    }
  };

  // Close popover on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSelectedEvent(null);
        setAnnotations([]);
      }
    }
    if (selectedEvent) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [selectedEvent]);

  const now = new Date();
  const isViewingCurrentMonth =
    currentMonth.getFullYear() === now.getFullYear() &&
    currentMonth.getMonth() === now.getMonth();

  return (
    <div className="mt-10 relative">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Bond Timeline</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentMonth(new Date())}
            disabled={isViewingCurrentMonth}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-card disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Today
          </button>
          <button
            onClick={prevMonth}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-card"
          >
            ←
          </button>
          <span className="text-xs font-medium min-w-32 text-center">
            {firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </span>
          <button
            onClick={nextMonth}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-card"
          >
            →
          </button>
        </div>
      </div>

      {events.length === 0 && (
        <div className="mb-4 rounded-md border border-border bg-card p-3 text-xs text-muted italic text-center">
          No bond activity yet this month
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="grid grid-cols-7 bg-muted/10">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
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
                  className={`min-h-20 p-2 text-xs ${isCurrentMonth ? 'bg-card' : 'bg-muted/5 text-muted/50'}`}
                >
                  <p className="font-semibold">{date.getDate()}</p>
                  <div className="mt-1 space-y-0.5">
                    {dayEvents.slice(0, 2).map((e) => (
                      <button
                        key={e.id}
                        onClick={() => handleEventClick(e)}
                        className={`w-full text-left px-1 py-0.5 rounded text-xs truncate font-medium ${getEventColor(e.kind)} hover:opacity-80 cursor-pointer ${selectedEvent?.id === e.id ? 'ring-1 ring-accent' : ''}`}
                        title={`${e.kind} — click to view annotations`}
                      >
                        {e.kind.split('_').pop()}
                      </button>
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

      {/* Annotation popover */}
      {selectedEvent && (
        <div
          ref={popoverRef}
          className="absolute z-50 mt-2 w-80 rounded-lg border border-border bg-card shadow-lg p-3"
          style={{ top: '100%', right: 0 }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">{selectedEvent.kind.replace(/_/g, ' ')}</h3>
            <button
              onClick={() => {
                setSelectedEvent(null);
                setAnnotations([]);
              }}
              className="text-muted hover:text-foreground text-xs"
            >
              ✕
            </button>
          </div>
          <p className="text-xs text-muted mb-2">
            {new Date(selectedEvent.createdAt).toLocaleString()}
          </p>

          {/* Annotations list */}
          <div className="max-h-48 overflow-y-auto space-y-2 mb-2">
            {loadingAnnotations ? (
              <p className="text-xs text-muted">Loading annotations…</p>
            ) : annotations.length === 0 ? (
              <p className="text-xs text-muted italic">No annotations yet</p>
            ) : (
              annotations.map((ann) => (
                <div key={ann.id} className="text-xs border border-border rounded p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-muted">
                      {ann.authorRole === 'surety_admin' ? 'Admin' : 'Importer'} ·{' '}
                      {new Date(ann.createdAt).toLocaleDateString()}
                    </span>
                    {userRole === ann.authorRole && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => {
                            setEditingId(ann.id);
                            setEditNote(ann.note);
                          }}
                          className="text-accent hover:underline"
                        >
                          edit
                        </button>
                        <button
                          onClick={() => handleDeleteAnnotation(ann.id)}
                          className="text-danger hover:underline"
                        >
                          del
                        </button>
                      </div>
                    )}
                  </div>
                  {editingId === ann.id ? (
                    <div className="flex gap-1">
                      <input
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        className="flex-1 rounded border border-border px-1 py-0.5 text-xs"
                      />
                      <button
                        onClick={() => handleUpdateAnnotation(ann.id)}
                        className="text-accent text-xs"
                      >
                        save
                      </button>
                    </div>
                  ) : (
                    <p>{ann.note}</p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Add annotation */}
          {userRole && (
            <div className="flex gap-1">
              <input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Add a note…"
                className="flex-1 rounded border border-border px-2 py-1 text-xs"
                onKeyDown={(e) => e.key === 'Enter' && handleAddAnnotation()}
              />
              <button
                onClick={handleAddAnnotation}
                disabled={!newNote.trim()}
                className="rounded bg-accent text-accent-foreground px-2 py-1 text-xs hover:opacity-90 disabled:opacity-50"
              >
                Add
              </button>
            </div>
          )}
        </div>
      )}

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
