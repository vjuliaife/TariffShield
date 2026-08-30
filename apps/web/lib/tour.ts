'use client';

import { getUser } from './auth';

// Issue #1033 — per-user, per-feature guided-tour completion state,
// namespaced by user id so switching accounts doesn't leak "seen it" state.
function storageKey(tourKey: string): string {
  const userId = getUser()?.id ?? 'anonymous';
  return `tariffshield_tour_${tourKey}_${userId}`;
}

export function hasTourCompleted(tourKey: string): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(storageKey(tourKey)) === 'done';
}

export function markTourCompleted(tourKey: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(tourKey), 'done');
}
