'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api, type DashboardWidgetId } from '@/lib/api';

const DEFAULT_ORDER: DashboardWidgetId[] = ['health', 'balance', 'yield', 'activity'];
const LABELS: Record<DashboardWidgetId, string> = {
  health: 'Health score',
  balance: 'Bond balance',
  yield: 'Yield projection',
  activity: 'Bond activity',
};

export function DashboardWidgetLayout({
  widgets,
}: {
  widgets: Record<DashboardWidgetId, ReactNode>;
}) {
  const [order, setOrder] = useState(DEFAULT_ORDER);
  const [hidden, setHidden] = useState<DashboardWidgetId[]>([]);
  const [dragging, setDragging] = useState<DashboardWidgetId | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');

  useEffect(() => {
    api
      .dashboardPreferences()
      .then((preferences) => {
        setOrder(preferences.widgetOrder);
        setHidden(preferences.hiddenWidgets);
      })
      .catch(() => setSaveState('error'));
  }, []);

  async function persist(nextOrder: DashboardWidgetId[], nextHidden: DashboardWidgetId[]) {
    setOrder(nextOrder);
    setHidden(nextHidden);
    setSaveState('saving');
    try {
      const saved = await api.saveDashboardPreferences({
        widgetOrder: nextOrder,
        hiddenWidgets: nextHidden,
      });
      setOrder(saved.widgetOrder);
      setHidden(saved.hiddenWidgets);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  function moveWidget(target: DashboardWidgetId) {
    if (!dragging || dragging === target) return;
    const next = [...order];
    const from = next.indexOf(dragging);
    const to = next.indexOf(target);
    next.splice(from, 1);
    next.splice(to, 0, dragging);
    setDragging(null);
    void persist(next, hidden);
  }

  function moveBy(id: DashboardWidgetId, offset: number) {
    const from = order.indexOf(id);
    const to = Math.max(0, Math.min(order.length - 1, from + offset));
    if (from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    void persist(next, hidden);
  }

  return (
    <>
      <details className="mt-5 rounded-md border border-border bg-card px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Customize dashboard</summary>
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted">Drag to reorder; uncheck a widget to hide it.</p>
          {order.map((id) => (
            <div
              key={id}
              draggable
              onDragStart={() => setDragging(id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveWidget(id)}
              className="flex items-center gap-3 rounded border border-border px-3 py-2"
            >
              <span aria-hidden="true" className="cursor-grab text-muted">
                ⠿
              </span>
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!hidden.includes(id)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? hidden.filter((item) => item !== id)
                      : [...hidden, id];
                    void persist(order, next);
                  }}
                />
                {LABELS[id]}
              </label>
              <div className="flex gap-1 sm:hidden">
                <button
                  type="button"
                  aria-label={`Move ${LABELS[id]} up`}
                  disabled={order[0] === id}
                  onClick={() => moveBy(id, -1)}
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${LABELS[id]} down`}
                  disabled={order.at(-1) === id}
                  onClick={() => moveBy(id, 1)}
                  className="rounded border border-border px-2 py-1 disabled:opacity-40"
                >
                  ↓
                </button>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted" role="status">
            {saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? 'Could not save preferences.'
                : 'Preferences saved'}
          </p>
        </div>
      </details>
      <div className="mt-4 space-y-4">
        {order
          .filter((id) => !hidden.includes(id))
          .map((id) => (
            <div key={id}>{widgets[id]}</div>
          ))}
      </div>
    </>
  );
}
