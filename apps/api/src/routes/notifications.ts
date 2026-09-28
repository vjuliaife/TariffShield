import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_CHANNELS,
  getPreferenceGrid,
  setPreference,
} from '../services/notification-preferences.js';

export const notificationsRouter = Router();
notificationsRouter.use(authMiddleware);
notificationsRouter.use(privacyReacceptanceGate);
notificationsRouter.use(tosReacceptanceGate);

// Cursor pagination, mirroring the exact convention already established for
// GET /importers/:id/events (base64 "<created_at ISO>|<id>" keyset — see the
// comment on that endpoint for the full rationale). Not shared as a common
// utility with that endpoint: doing so would mean editing an unrelated,
// already-working route in importers.ts, which is out of this issue's scope.
function decodeNotificationsCursor(raw: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep === -1) return null;
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function encodeNotificationsCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

const NotificationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// GET /notifications — paginated, for the authenticated user, most recent first.
notificationsRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = NotificationsQuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid query', details: parse.error.issues });
    return;
  }
  const { limit } = parse.data;

  let cursor: { createdAt: string; id: string } | null = null;
  if (parse.data.cursor) {
    cursor = decodeNotificationsCursor(parse.data.cursor);
    if (!cursor) {
      res.status(400).json({ error: 'invalid cursor' });
      return;
    }
  }

  // Lists ALL of the user's notifications (read and unread), so this query
  // doesn't match idx_notifications_user_unread's partial WHERE read_at IS
  // NULL predicate — that index is shaped for the unread-count endpoint
  // below, not this one. At one user's realistic notification volume this
  // is a cheap sequential scan + sort either way; not adding a second index
  // beyond the one the issue's DDL specifies.
  const rows = cursor
    ? await pool.query(
        `SELECT id, kind, message, read_at, created_at FROM notifications
         WHERE user_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [user.id, cursor.createdAt, cursor.id, limit]
      )
    : await pool.query(
        `SELECT id, kind, message, read_at, created_at FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [user.id, limit]
      );

  const notifications = rows.rows.map((n) => ({
    id: n.id,
    kind: n.kind,
    message: n.message,
    readAt: n.read_at,
    createdAt: n.created_at,
  }));

  const last = rows.rows[rows.rows.length - 1];
  const nextCursor =
    rows.rows.length === limit && last ? encodeNotificationsCursor(last.created_at, last.id) : null;

  res.json({ notifications, nextCursor });
});

// GET /notifications/unread-count — count of this user's unread notifications.
notificationsRouter.get('/unread-count', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const r = await pool.query(
    'SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [user.id]
  );

  res.json({ unreadCount: Number(r.rows[0]!.count) });
});

// PATCH /notifications/:id/read — mark one notification read (owner or surety_admin).
notificationsRouter.patch('/:id/read', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const notificationId = String(req.params.id ?? '');

  // read_at is only ever set once, on first read (COALESCE), so a repeat
  // PATCH is a safe no-op that preserves the original read timestamp rather
  // than resetting it.
  const r =
    user.role === 'surety_admin'
      ? await pool.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
           WHERE id = $1
           RETURNING id, kind, message, read_at, created_at`,
          [notificationId]
        )
      : await pool.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, now())
           WHERE id = $1 AND user_id = $2
           RETURNING id, kind, message, read_at, created_at`,
          [notificationId, user.id]
        );

  const notification = r.rows[0];
  if (!notification) {
    // Generic 404 whether the row doesn't exist or belongs to someone else —
    // matches loadImporterFor's convention elsewhere in this codebase of not
    // distinguishing "not found" from "not yours" in the response.
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.json({
    notification: {
      id: notification.id,
      kind: notification.kind,
      message: notification.message,
      readAt: notification.read_at,
      createdAt: notification.created_at,
    },
  });
});

// ── #990: GET/PUT /notifications/preferences — per-event, per-channel toggles ──

// GET /notifications/preferences — full grid (eventType x channel), defaulted
// to enabled, with `locked: true` on pairs that can't be disabled (critical
// compliance categories on the in_app channel).
notificationsRouter.get('/preferences', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const grid = await getPreferenceGrid(user.id);
  res.json({ preferences: grid });
});

const SetPreferenceSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENT_TYPES),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

const PutPreferencesSchema = z.object({
  preferences: z.array(SetPreferenceSchema).min(1).max(100),
});

// PUT /notifications/preferences — bulk-upsert one or more toggles.
notificationsRouter.put('/preferences', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = PutPreferencesSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  for (const { eventType, channel, enabled } of parse.data.preferences) {
    try {
      await setPreference(user.id, eventType, channel, enabled);
    } catch (err) {
      // setPreference throws only for "disable a locked critical pair".
      res.status(400).json({
        error: err instanceof Error ? err.message : 'invalid preference change',
      });
      return;
    }
  }

  const grid = await getPreferenceGrid(user.id);
  res.json({ preferences: grid });
});

// ── #1017: Configurable Health Score Alert Thresholds ────────────────────────

const HealthThresholdsSchema = z
  .object({
    warningThreshold: z.number().int().min(1).max(100),
    criticalThreshold: z.number().int().min(0).max(99),
  })
  .refine((data) => data.criticalThreshold < data.warningThreshold, {
    message: 'criticalThreshold must be strictly less than warningThreshold',
  });

// GET /notifications/thresholds/:importerId — get importer health score thresholds
notificationsRouter.get('/thresholds/:importerId', async (req: Request, res: Response) => {
  const importerId = String(req.params.importerId ?? '');

  const result = await pool.query(
    'SELECT warning_threshold, critical_threshold, last_notified_state FROM importer_health_thresholds WHERE importer_id = $1',
    [importerId]
  );

  if (result.rowCount === 0) {
    res.json({
      thresholds: {
        warningThreshold: 60,
        criticalThreshold: 40,
        lastNotifiedState: 'NORMAL',
      },
    });
    return;
  }

  const row = result.rows[0];
  res.json({
    thresholds: {
      warningThreshold: row.warning_threshold,
      criticalThreshold: row.critical_threshold,
      lastNotifiedState: row.last_notified_state,
    },
  });
});

// PUT /notifications/thresholds/:importerId — configure importer health score thresholds
notificationsRouter.put('/thresholds/:importerId', async (req: Request, res: Response) => {
  const importerId = String(req.params.importerId ?? '');

  const parse = HealthThresholdsSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid threshold configuration', details: parse.error.issues });
    return;
  }

  const { warningThreshold, criticalThreshold } = parse.data;

  try {
    const upserted = await pool.query(
      `INSERT INTO importer_health_thresholds (importer_id, warning_threshold, critical_threshold, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (importer_id) DO UPDATE
         SET warning_threshold = EXCLUDED.warning_threshold,
             critical_threshold = EXCLUDED.critical_threshold,
             updated_at = NOW()
       RETURNING warning_threshold, critical_threshold, last_notified_state`,
      [importerId, warningThreshold, criticalThreshold]
    );

    const row = upserted.rows[0];
    res.json({
      thresholds: {
        warningThreshold: row.warning_threshold,
        criticalThreshold: row.critical_threshold,
        lastNotifiedState: row.last_notified_state,
      },
    });
  } catch (err: any) {
    console.error('[notifications] failed to update health thresholds:', err);
    res.status(500).json({ error: 'failed to update threshold settings' });
  }
});

