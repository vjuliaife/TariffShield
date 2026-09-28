import { pool, createNotification } from '../db.js';
import { enqueueTxSubmit } from '../queue.js';
import { contractClient } from '../stellar.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';
import { invalidateOnChainAccount } from '../cache.js';
import { logger } from '../lib/logger.js';

export interface ProcessWithdrawalResult {
  withdrawalId: string;
  importerId: string;
  status: 'executed' | 'blocked' | 'failed';
  jobId?: string;
  reason?: string;
}

/**
 * Re-validates required_collateral on the target date before executing withdraw_collateral (#994).
 * If required collateral has increased and the withdrawal would cause a shortfall,
 * the request is blocked and the importer notified.
 */
export async function processDueScheduledWithdrawals(): Promise<ProcessWithdrawalResult[]> {
  const results: ProcessWithdrawalResult[] = [];

  const dueQuery = await pool.query<{
    id: string;
    importer_id: string;
    requested_by: string;
    amount_stroops: string;
    target_date: Date;
    target_address: string | null;
    stellar_address: string;
    stellar_secret_encrypted: string;
    kyc_status: string;
    user_id: string;
  }>(
    `SELECT sw.id, sw.importer_id, sw.requested_by, sw.amount_stroops::text AS amount_stroops,
            sw.target_date, sw.target_address, i.stellar_address, i.stellar_secret_encrypted,
            i.kyc_status, i.user_id
     FROM scheduled_withdrawals sw
     JOIN importers i ON i.id = sw.importer_id
     WHERE sw.status = 'pending' AND sw.target_date <= now()
     ORDER BY sw.target_date ASC`
  );

  for (const sw of dueQuery.rows) {
    if (sw.kyc_status !== 'approved') {
      const reason = 'KYC approval required before collateral withdrawals';
      await pool.query(
        `UPDATE scheduled_withdrawals
         SET status = 'blocked', execution_result = $1, executed_at = now(), updated_at = now()
         WHERE id = $2`,
        [reason, sw.id]
      );
      await createNotification(
        sw.user_id,
        NOTIFICATION_KINDS.SCHEDULED_WITHDRAWAL_BLOCKED,
        `Scheduled withdrawal of ${sw.amount_stroops} stroops blocked: ${reason}.`
      );
      results.push({
        withdrawalId: sw.id,
        importerId: sw.importer_id,
        status: 'blocked',
        reason,
      });
      continue;
    }

    try {
      // Re-validate required_collateral against current on-chain state
      const acct = await contractClient.getAccount(sw.stellar_address);
      const collateralBalance = acct.collateralBalance;
      const requiredCollateral = acct.requiredCollateral;
      const amountStroops = BigInt(sw.amount_stroops);

      // Check if withdrawal would cause a collateral shortfall
      if (collateralBalance - amountStroops < requiredCollateral) {
        const reason = `Collateral requirement breach: available balance (${collateralBalance.toString()}) minus withdrawal (${amountStroops.toString()}) is less than required collateral (${requiredCollateral.toString()})`;
        logger.warn(
          { withdrawalId: sw.id, collateralBalance: collateralBalance.toString(), requiredCollateral: requiredCollateral.toString(), amount: amountStroops.toString() },
          'scheduled withdrawal blocked due to collateral requirement breach'
        );

        await pool.query(
          `UPDATE scheduled_withdrawals
           SET status = 'blocked', execution_result = $1, executed_at = now(), updated_at = now()
           WHERE id = $2`,
          [reason, sw.id]
        );

        // Notify importer of blocked withdrawal (#994 AC 3)
        await createNotification(
          sw.user_id,
          NOTIFICATION_KINDS.SCHEDULED_WITHDRAWAL_BLOCKED,
          `Scheduled withdrawal of ${sw.amount_stroops} stroops blocked: required collateral has increased and executing this withdrawal would cause a shortfall.`
        );

        results.push({
          withdrawalId: sw.id,
          importerId: sw.importer_id,
          status: 'blocked',
          reason,
        });
        continue;
      }

      // Obligations satisfied: execute withdraw_collateral via the transaction queue
      const jobId = await enqueueTxSubmit({
        method: 'withdraw',
        importerId: sw.importer_id,
        keypairSecret: sw.stellar_secret_encrypted,
        args: {
          importerAddress: sw.stellar_address,
          sourceAddress: sw.target_address || sw.stellar_address,
          amountStroops: sw.amount_stroops,
        },
      });

      await pool.query(
        `UPDATE scheduled_withdrawals
         SET status = 'executed', job_id = $1, execution_result = 'Submitted to transaction queue',
             executed_at = now(), updated_at = now()
         WHERE id = $2`,
        [jobId, sw.id]
      );

      await invalidateOnChainAccount(sw.importer_id);

      await createNotification(
        sw.user_id,
        NOTIFICATION_KINDS.SCHEDULED_WITHDRAWAL_EXECUTED,
        `Scheduled withdrawal of ${sw.amount_stroops} stroops executed successfully.`
      );

      results.push({
        withdrawalId: sw.id,
        importerId: sw.importer_id,
        status: 'executed',
        jobId,
      });
    } catch (err: any) {
      const errMsg = err?.message || 'Withdrawal execution error';
      logger.error({ err, withdrawalId: sw.id }, 'scheduled withdrawal execution failed');

      await pool.query(
        `UPDATE scheduled_withdrawals
         SET execution_result = $1, updated_at = now()
         WHERE id = $2`,
        [errMsg, sw.id]
      );

      results.push({
        withdrawalId: sw.id,
        importerId: sw.importer_id,
        status: 'failed',
        reason: errMsg,
      });
    }
  }

  return results;
}
