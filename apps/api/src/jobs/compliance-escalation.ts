import { pool, createNotification } from '../db.js';
import { logger } from '../lib/logger.js';

/**
 * Periodic job that checks for compliance flags exceeding age thresholds
 * and escalates them according to configured rules.
 *
 * Issue #1034: Automated Escalation Rules for Unresolved Compliance Flags
 *
 * Runs every 15 minutes to check unresolved flags against active escalation rules.
 */
export function startComplianceEscalation(): void {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  async function checkAndEscalate(): Promise<void> {
    try {
      // Get all active escalation rules
      const rulesResult = await pool.query<{
        id: string;
        surety_id: string;
        age_threshold_hours: number;
        escalation_target_role: string;
        escalation_target_user_id: string | null;
      }>(
        `SELECT id, surety_id, age_threshold_hours, escalation_target_role, escalation_target_user_id
         FROM compliance_escalation_rules
         WHERE is_active = TRUE`
      );

      if (!rulesResult.rowCount) {
        return;
      }

      for (const rule of rulesResult.rows) {
        // Find flags that exceed the threshold and haven't been escalated yet
        const flagsResult = await pool.query<{
          id: string;
          importer_id: string;
          flag_type: string;
          severity: string;
          age_hours: number;
        }>(
          `SELECT cf.id, cf.importer_id, cf.flag_type, cf.severity,
                  EXTRACT(EPOCH FROM (now() - cf.created_at)) / 3600 AS age_hours
           FROM compliance_flags cf
           WHERE cf.surety_id = $1
             AND cf.resolution_status = 'open'
             AND cf.case_status != 'escalated'
             AND EXTRACT(EPOCH FROM (now() - cf.created_at)) / 3600 > $2`,
          [rule.surety_id, rule.age_threshold_hours]
        );

        if (!flagsResult.rowCount) {
          continue;
        }

        // Determine escalation target
        let targetUserId = rule.escalation_target_user_id;
        if (!targetUserId && rule.escalation_target_role === 'senior_admin') {
          // Find a senior admin for this surety
          const targetResult = await pool.query<{ id: string }>(
            `SELECT id FROM users 
             WHERE role = 'surety_admin' 
               AND id = $1
             LIMIT 1`,
            [rule.surety_id]
          );
          targetUserId = targetResult.rows[0]?.id;
        }

        if (!targetUserId) {
          logger.warn({ ruleId: rule.id }, 'No escalation target found for rule');
          continue;
        }

        // Escalate each flag
        for (const flag of flagsResult.rows) {
          try {
            // Update flag status to escalated and reassign
            await pool.query(
              `UPDATE compliance_flags
               SET case_status = 'escalated',
                   assigned_to = $1,
                   priority = CASE 
                     WHEN priority = 'low' THEN 'medium'
                     WHEN priority = 'medium' THEN 'high'
                     WHEN priority = 'high' THEN 'critical'
                     ELSE priority
                   END,
                   updated_at = now()
               WHERE id = $2`,
              [targetUserId, flag.id]
            );

            // Record escalation history
            await pool.query(
              `INSERT INTO compliance_escalation_history 
                 (flag_id, escalation_rule_id, previous_assignee, new_assignee, escalated_at)
               VALUES ($1, $2, 
                 (SELECT assigned_to FROM compliance_flags WHERE id = $1), 
                 $3, now())`,
              [flag.id, rule.id, targetUserId]
            );

            // Notify the escalation target
            const message = `Compliance flag escalated: ${flag.flag_type.replace(/_/g, ' ')} (${flag.severity}) has exceeded ${rule.age_threshold_hours}h threshold. Age: ${Math.round(flag.age_hours)}h`;
            await createNotification(targetUserId, 'compliance_escalation', message);

            logger.info(
              {
                flagId: flag.id,
                ruleId: rule.id,
                targetUserId,
                ageHours: flag.age_hours,
              },
              'Compliance flag escalated'
            );
          } catch (err) {
            logger.error(
              { err, flagId: flag.id, ruleId: rule.id },
              'Failed to escalate compliance flag'
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Compliance escalation check failed');
    }
  }

  // Run immediately, then on interval
  checkAndEscalate();
  setInterval(checkAndEscalate, INTERVAL_MS);
}
