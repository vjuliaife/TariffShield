import { pool, createNotification } from '../db.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { logger } from '../lib/logger.js';

/**
 * Records an upgrade proposal event and notifies all active subscribers
 * for the given surety tenant. Called when propose_upgrade, approve_upgrade,
 * or cancel_upgrade events occur.
 *
 * Issue #1047: Stakeholder notification subscriptions for upgrade proposals.
 */
export async function notifyUpgradeSubscribers(params: {
  suretyId: string;
  proposalId: number;
  eventType: 'proposed' | 'approved' | 'cancelled';
  proposer: string;
  approvalCount: number;
  wasmHash?: string;
}): Promise<void> {
  const { suretyId, proposalId, eventType, proposer, approvalCount, wasmHash } = params;

  // Record the event in history
  await pool.query(
    `INSERT INTO upgrade_notification_history (proposal_id, event_type, proposer, approval_count, wasm_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [proposalId, eventType, proposer, approvalCount, wasmHash ?? null]
  );

  // Find all active subscribers for this surety
  const subscribers = await pool.query(
    `SELECT user_id FROM upgrade_subscriptions
     WHERE surety_id = $1 AND is_active = TRUE`,
    [suretyId]
  );

  const kindMap = {
    proposed: NOTIFICATION_KINDS.UPGRADE_PROPOSED,
    approved: NOTIFICATION_KINDS.UPGRADE_APPROVED,
    cancelled: NOTIFICATION_KINDS.UPGRADE_CANCELLED,
  } as const;

  const kind = kindMap[eventType];
  const message = buildUpgradeMessage(eventType, proposalId, proposer, approvalCount);

  for (const row of subscribers.rows) {
    try {
      await createNotification(row.user_id, kind, message);
    } catch (err) {
      logger.error({ err, userId: row.user_id, proposalId }, 'failed to send upgrade notification');
    }
  }
}

function buildUpgradeMessage(
  eventType: 'proposed' | 'approved' | 'cancelled',
  proposalId: number,
  proposer: string,
  approvalCount: number
): string {
  switch (eventType) {
    case 'proposed':
      return `Contract upgrade proposal #${proposalId} has been raised by ${proposer.slice(0, 8)}…`;
    case 'approved':
      return `Contract upgrade proposal #${proposalId} has been approved (${approvalCount} approval${approvalCount !== 1 ? 's' : ''}).`;
    case 'cancelled':
      return `Contract upgrade proposal #${proposalId} has been cancelled by ${proposer.slice(0, 8)}…`;
  }
}
