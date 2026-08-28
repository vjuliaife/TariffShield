// #230 — shared notification `kind` values. `notifications.kind` is a plain
// TEXT column with no CHECK constraint (see the DDL in db.ts, given verbatim
// by the issue) — this constants file is what keeps every writer of a
// notification row using the same, consistent set of strings, and gives
// TypeScript callers compile-time checking that a raw string column can't.
export const NOTIFICATION_KINDS = {
  BOND_APPROVED: 'bond_approved',
  KYC_REJECTED: 'kyc_rejected',
  TARIFF_SPIKE: 'tariff_spike',
  EVENT_RECEIVED: 'event_received',
  UPGRADE_PROPOSED: 'upgrade_proposed',
  UPGRADE_APPROVED: 'upgrade_approved',
  UPGRADE_CANCELLED: 'upgrade_cancelled',
  SLA_BREACH: 'sla_breach',
  ONBOARDING_DRIP: 'onboarding_drip',
} as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];
