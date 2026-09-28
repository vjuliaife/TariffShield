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
  // #1007 — importer credit-line pre-approval lifecycle
  CREDIT_LINE_GRANTED: 'credit_line_granted',
  CREDIT_LINE_EXPIRING_SOON: 'credit_line_expiring_soon',
  CREDIT_LINE_EXPIRED: 'credit_line_expired',
  // #1009 — multi-step review chain outcome for the importer
  REVIEW_CHAIN_APPROVED: 'review_chain_approved',
  REVIEW_CHAIN_REJECTED: 'review_chain_rejected',
  REPORT_DELIVERY_FAILED: 'report_delivery_failed',
  // #993 — deposit scheduling notifications
  SCHEDULED_DEPOSIT_FAILED: 'scheduled_deposit_failed',
  SCHEDULED_DEPOSIT_SUCCESS: 'scheduled_deposit_success',
  // #994 — scheduled withdrawal notifications
  SCHEDULED_WITHDRAWAL_EXECUTED: 'scheduled_withdrawal_executed',
  SCHEDULED_WITHDRAWAL_BLOCKED: 'scheduled_withdrawal_blocked',
  // #991 — support ticket thread activity
  TICKET_REPLY: 'ticket_reply',
  TICKET_STATUS_CHANGED: 'ticket_status_changed',
} as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];
