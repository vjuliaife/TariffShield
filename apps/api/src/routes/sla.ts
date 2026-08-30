import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const slaRouter = Router();
slaRouter.use(authMiddleware);
slaRouter.use(privacyReacceptanceGate);
slaRouter.use(tosReacceptanceGate);
slaRouter.use(requireRole('surety_admin'));

// ── Business Hours Configuration ──────────────────────────────────────────

const DayTimeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .nullable()
  .optional();

// POST /sla/business-hours — configure business hours for a surety tenant
slaRouter.post('/business-hours', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      timezone: z.string().default('America/New_York'),
      monday_start: DayTimeSchema,
      monday_end: DayTimeSchema,
      tuesday_start: DayTimeSchema,
      tuesday_end: DayTimeSchema,
      wednesday_start: DayTimeSchema,
      wednesday_end: DayTimeSchema,
      thursday_start: DayTimeSchema,
      thursday_end: DayTimeSchema,
      friday_start: DayTimeSchema,
      friday_end: DayTimeSchema,
      saturday_start: DayTimeSchema,
      saturday_end: DayTimeSchema,
      sunday_start: DayTimeSchema,
      sunday_end: DayTimeSchema,
      holidays: z.array(z.string()).default([]),
    })
    .safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid configuration', details: parse.error.issues });
    return;
  }

  const data = parse.data;
  const suretyId = user.id;

  const existing = await pool.query(`SELECT id FROM business_hours_config WHERE surety_id = $1`, [
    suretyId,
  ]);

  if (existing.rowCount) {
    await pool.query(
      `UPDATE business_hours_config
       SET timezone = $1,
           monday_start = $2, monday_end = $3,
           tuesday_start = $4, tuesday_end = $5,
           wednesday_start = $6, wednesday_end = $7,
           thursday_start = $8, thursday_end = $9,
           friday_start = $10, friday_end = $11,
           saturday_start = $12, saturday_end = $13,
           sunday_start = $14, sunday_end = $15,
           holidays = $16, updated_at = now()
       WHERE surety_id = $17`,
      [
        data.timezone,
        data.monday_start,
        data.monday_end,
        data.tuesday_start,
        data.tuesday_end,
        data.wednesday_start,
        data.wednesday_end,
        data.thursday_start,
        data.thursday_end,
        data.friday_start,
        data.friday_end,
        data.saturday_start,
        data.saturday_end,
        data.sunday_start,
        data.sunday_end,
        JSON.stringify(data.holidays),
        suretyId,
      ]
    );
  } else {
    await pool.query(
      `INSERT INTO business_hours_config
       (surety_id, timezone,
        monday_start, monday_end, tuesday_start, tuesday_end,
        wednesday_start, wednesday_end, thursday_start, thursday_end,
        friday_start, friday_end, saturday_start, saturday_end,
        sunday_start, sunday_end, holidays)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        suretyId,
        data.timezone,
        data.monday_start,
        data.monday_end,
        data.tuesday_start,
        data.tuesday_end,
        data.wednesday_start,
        data.wednesday_end,
        data.thursday_start,
        data.thursday_end,
        data.friday_start,
        data.friday_end,
        data.saturday_start,
        data.saturday_end,
        data.sunday_start,
        data.sunday_end,
        JSON.stringify(data.holidays),
      ]
    );
  }

  res.json({ success: true });
});

// GET /sla/business-hours — get current business hours configuration
slaRouter.get('/business-hours', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const result = await pool.query(`SELECT * FROM business_hours_config WHERE surety_id = $1`, [
    user.id,
  ]);

  if (!result.rowCount) {
    res.json({
      timezone: 'America/New_York',
      monday_start: '09:00',
      monday_end: '17:00',
      tuesday_start: '09:00',
      tuesday_end: '17:00',
      wednesday_start: '09:00',
      wednesday_end: '17:00',
      thursday_start: '09:00',
      thursday_end: '17:00',
      friday_start: '09:00',
      friday_end: '17:00',
      saturday_start: null,
      saturday_end: null,
      sunday_start: null,
      sunday_end: null,
      holidays: [],
    });
    return;
  }

  res.json(result.rows[0]);
});

// ── SLA Targets ───────────────────────────────────────────────────────────

// POST /sla/targets — configure SLA target hours per item type
slaRouter.post('/targets', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      item_type: z.enum(['compliance_flag', 'dispute', 'ticket']),
      target_hours: z.number().positive(),
    })
    .safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'item_type and target_hours are required' });
    return;
  }

  const { item_type, target_hours } = parse.data;

  const existing = await pool.query(
    `SELECT id FROM sla_targets WHERE surety_id = $1 AND item_type = $2`,
    [user.id, item_type]
  );

  if (existing.rowCount) {
    await pool.query(
      `UPDATE sla_targets SET target_hours = $1, updated_at = now()
       WHERE surety_id = $2 AND item_type = $3`,
      [target_hours, user.id, item_type]
    );
  } else {
    await pool.query(
      `INSERT INTO sla_targets (surety_id, item_type, target_hours)
       VALUES ($1, $2, $3)`,
      [user.id, item_type, target_hours]
    );
  }

  res.json({ success: true });
});

// GET /sla/targets — list all SLA targets for this surety
slaRouter.get('/targets', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const result = await pool.query(
    `SELECT id, item_type, target_hours, created_at, updated_at
     FROM sla_targets
     WHERE surety_id = $1
     ORDER BY item_type`,
    [user.id]
  );

  res.json({ targets: result.rows });
});

// ── SLA Tracking & Breach Flagging ────────────────────────────────────────

// GET /sla/tracking — list SLA items with breach status
slaRouter.get('/tracking', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const query = z
    .object({
      item_type: z.enum(['compliance_flag', 'dispute', 'ticket']).optional(),
      breached_only: z.coerce.boolean().default(false),
      resolved: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().positive().max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'invalid query parameters' });
    return;
  }

  const { item_type, breached_only, resolved, limit, offset } = query.data;
  const conditions: string[] = ['st.surety_id = $1'];
  const params: unknown[] = [user.id];
  let idx = 2;

  if (item_type) {
    conditions.push(`st.item_type = $${idx++}`);
    params.push(item_type);
  }
  if (breached_only) {
    conditions.push(`st.is_breached = TRUE`);
  }
  if (resolved !== undefined) {
    if (resolved) {
      conditions.push(`st.resolved_at IS NOT NULL`);
    } else {
      conditions.push(`st.resolved_at IS NULL`);
    }
  }

  const where = conditions.join(' AND ');

  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT st.id, st.item_type, st.item_id, st.started_at, st.deadline,
              st.resolved_at, st.is_breached, st.created_at
       FROM sla_tracking st
       WHERE ${where}
       ORDER BY st.is_breached DESC, st.deadline ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    ),
    pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM sla_tracking st WHERE ${where}`,
      params
    ),
  ]);

  res.json({
    items: rows.rows,
    total: parseInt(total.rows[0]?.cnt ?? '0', 10),
    limit,
    offset,
  });
});

// GET /sla/compliance-rate — SLA compliance rate over a date range
slaRouter.get('/compliance-rate', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      item_type: z.enum(['compliance_flag', 'dispute', 'ticket']).optional(),
    })
    .safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid query parameters' });
    return;
  }

  const { from, to, item_type } = parse.data;
  const conditions: string[] = ['surety_id = $1'];
  const params: unknown[] = [user.id];
  let idx = 2;

  if (from) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(to);
  }
  if (item_type) {
    conditions.push(`item_type = $${idx++}`);
    params.push(item_type);
  }

  const where = conditions.join(' AND ');

  const result = await pool.query<{ total: string; breaches: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE is_breached = TRUE) AS breaches
     FROM sla_tracking
     WHERE ${where}`,
    params
  );

  const row = result.rows[0];
  const total = parseInt(row?.total ?? '0', 10);
  const breaches = parseInt(row?.breaches ?? '0', 10);
  const complianceRate = total > 0 ? ((total - breaches) / total) * 100 : 100;

  res.json({ total, breaches, complianceRate: Math.round(complianceRate * 100) / 100 });
});

// POST /sla/tracking — start SLA tracking for a new item
slaRouter.post('/tracking', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      item_type: z.enum(['compliance_flag', 'dispute', 'ticket']),
      item_id: z.string().uuid(),
    })
    .safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'item_type and item_id are required' });
    return;
  }

  const { item_type, item_id } = parse.data;

  // Get the SLA target for this item type
  const targetResult = await pool.query(
    `SELECT target_hours FROM sla_targets WHERE surety_id = $1 AND item_type = $2`,
    [user.id, item_type]
  );

  if (!targetResult.rowCount) {
    res.status(400).json({ error: 'no SLA target configured for this item type' });
    return;
  }

  const targetHours = parseFloat(targetResult.rows[0]!.target_hours);
  const deadline = new Date(Date.now() + targetHours * 3600 * 1000);

  const result = await pool.query(
    `INSERT INTO sla_tracking (surety_id, item_type, item_id, deadline)
     VALUES ($1, $2, $3, $4)
     RETURNING id, item_type, item_id, started_at, deadline, is_breached, created_at`,
    [user.id, item_type, item_id, deadline.toISOString()]
  );

  res.status(201).json({ tracking: result.rows[0] });
});

// PATCH /sla/tracking/:id/resolve — mark an SLA item as resolved
slaRouter.patch('/tracking/:id/resolve', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const trackingId = String(req.params.id);

  const result = await pool.query(
    `UPDATE sla_tracking
     SET resolved_at = now(), updated_at = now()
     WHERE id = $1 AND surety_id = $2 AND resolved_at IS NULL
     RETURNING id, item_type, item_id, started_at, deadline, resolved_at, is_breached`,
    [trackingId, user.id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'tracking entry not found or already resolved' });
    return;
  }

  res.json({ tracking: result.rows[0] });
});
