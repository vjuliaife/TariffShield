import { pool } from '../db.js';
import { NOTIFICATION_KINDS, type NotificationKind } from '../constants/notification-kinds.js';

// #990 — the four toggleable event categories from the issue. Every other
// NOTIFICATION_KINDS value (bond approvals, SLA breaches, etc.) is not yet
// wired into the preference center and always sends, same as before this
// feature existed.
export const NOTIFICATION_EVENT_TYPES = ['top_up', 'clawback', 'dispute', 'kyc'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['email', 'sms', 'in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// Compliance-critical categories the importer cannot fully silence (issue
// acceptance criteria: "Critical compliance notices cannot be fully
// disabled"). clawback and kyc are the two categories this product
// treats as regulator-facing/compliance events; top_up and dispute remain
// fully optional.
const CRITICAL_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set(['clawback', 'kyc']);

const KIND_TO_EVENT_TYPE: Partial<Record<NotificationKind, NotificationEventType>> = {
  [NOTIFICATION_KINDS.KYC_REJECTED]: 'kyc',
};

/** Best-effort mapping from a raw notification `kind` string to a preference event type. */
export function eventTypeForKind(kind: string): NotificationEventType | null {
  if ((KIND_TO_EVENT_TYPE as Record<string, NotificationEventType>)[kind]) {
    return (KIND_TO_EVENT_TYPE as Record<string, NotificationEventType>)[kind]!;
  }
  if (kind === 'top_up' || kind === 'clawback' || kind === 'dispute' || kind === 'kyc') {
    return kind;
  }
  return null;
}

/**
 * Whether `userId` should receive `eventType` notifications on `channel`.
 * Defaults to enabled when no row exists (opt-out model, matching how every
 * notification worked before preferences existed). A critical event type on
 * the in_app channel is always enabled regardless of a stored preference —
 * that channel is the one the compliance dashboard and audit trail rely on
 * being reliably populated.
 */
export async function shouldSendNotification(
  userId: string,
  eventType: NotificationEventType,
  channel: NotificationChannel
): Promise<boolean> {
  if (channel === 'in_app' && CRITICAL_EVENT_TYPES.has(eventType)) {
    return true;
  }
  const r = await pool.query(
    `SELECT enabled FROM notification_preferences WHERE user_id = $1 AND event_type = $2 AND channel = $3`,
    [userId, eventType, channel]
  );
  if (r.rowCount === 0) {
    return true;
  }
  return Boolean(r.rows[0]!.enabled);
}

export interface NotificationPreferenceRow {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  enabled: boolean;
  locked: boolean;
}

/** Full preference grid for the settings page: every (eventType, channel) pair, defaulted. */
export async function getPreferenceGrid(userId: string): Promise<NotificationPreferenceRow[]> {
  const r = await pool.query(
    `SELECT event_type, channel, enabled FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  const stored = new Map(r.rows.map((row) => [`${row.event_type}:${row.channel}`, row.enabled]));

  const grid: NotificationPreferenceRow[] = [];
  for (const eventType of NOTIFICATION_EVENT_TYPES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const locked = channel === 'in_app' && CRITICAL_EVENT_TYPES.has(eventType);
      const key = `${eventType}:${channel}`;
      grid.push({
        eventType,
        channel,
        enabled: locked ? true : (stored.get(key) ?? true),
        locked,
      });
    }
  }
  return grid;
}

/** Upserts one (eventType, channel) toggle. Rejects trying to disable a locked/critical pair. */
export async function setPreference(
  userId: string,
  eventType: NotificationEventType,
  channel: NotificationChannel,
  enabled: boolean
): Promise<void> {
  if (channel === 'in_app' && CRITICAL_EVENT_TYPES.has(eventType) && !enabled) {
    throw new Error('critical compliance notifications cannot be disabled');
  }
  await pool.query(
    `INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, event_type, channel) DO UPDATE SET enabled = $4, updated_at = now()`,
    [userId, eventType, channel, enabled]
  );
}
