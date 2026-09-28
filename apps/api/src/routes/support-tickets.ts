import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool, logAudit, createNotification } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { NOTIFICATION_KINDS } from '../constants/notification-kinds.js';

// #991 — lightweight support ticketing between importers and surety_admin.
// Mounted twice from index.ts: `supportTicketsRouter` at '/importers'
// (importer-scoped create/list/reply/thread) and `adminSupportTicketsRouter`
// at '/admin' (admin reply + status change), mirroring how kyc.ts and
// importers.ts already split importer- vs admin-side handlers for one
// resource across two mount points.

async function loadImporterFor(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  if (user.role === 'surety_admin') {
    const r = await pool.query('SELECT * FROM importers WHERE id = $1', [importerId]);
    return r.rows[0] ?? null;
  }
  const r = await pool.query('SELECT * FROM importers WHERE id = $1 AND user_id = $2', [
    importerId,
    user.id,
  ]);
  return r.rows[0] ?? null;
}

async function loadTicketFor(req: Request, ticketId: string) {
  const user = (req as AuthedRequest).user;
  const r = await pool.query(
    `SELECT t.*, i.user_id AS importer_user_id
     FROM support_tickets t
     JOIN importers i ON i.id = t.importer_id
     WHERE t.id = $1`,
    [ticketId]
  );
  const ticket = r.rows[0];
  if (!ticket) return null;
  if (user.role !== 'surety_admin' && ticket.importer_user_id !== user.id) {
    return null;
  }
  return ticket;
}

function serializeTicket(t: any) {
  return {
    id: t.id,
    importerId: t.importer_id,
    subject: t.subject,
    status: t.status,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function serializeReply(r: any) {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    authorUserId: r.author_user_id,
    body: r.body,
    createdAt: r.created_at,
  };
}

export const supportTicketsRouter = Router();
supportTicketsRouter.use(authMiddleware);
supportTicketsRouter.use(privacyReacceptanceGate);
supportTicketsRouter.use(tosReacceptanceGate);

const CreateTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

// POST /importers/:id/tickets
supportTicketsRouter.post('/:id/tickets', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const parse = CreateTicketSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  const ticketResult = await pool.query(
    `INSERT INTO support_tickets (importer_id, opened_by_user_id, subject)
     VALUES ($1, $2, $3) RETURNING *`,
    [importer.id, user.id, parse.data.subject]
  );
  const ticket = ticketResult.rows[0];

  await pool.query(
    `INSERT INTO support_ticket_replies (ticket_id, author_user_id, body) VALUES ($1, $2, $3)`,
    [ticket.id, user.id, parse.data.body]
  );

  await logAudit(user.id, 'support_ticket_opened', ticket.id, {
    importerId: importer.id,
    subject: parse.data.subject,
  });

  res.status(201).json({ ticket: serializeTicket(ticket) });
});

// GET /importers/:id/tickets — the importer dashboard's ticket list.
supportTicketsRouter.get('/:id/tickets', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const r = await pool.query(
    `SELECT * FROM support_tickets WHERE importer_id = $1 ORDER BY updated_at DESC`,
    [importer.id]
  );
  res.json({ tickets: r.rows.map(serializeTicket) });
});

// GET /importers/:id/tickets/:ticketId — thread view.
supportTicketsRouter.get('/:id/tickets/:ticketId', async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ''));
  if (!importer) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const t = await pool.query('SELECT * FROM support_tickets WHERE id = $1 AND importer_id = $2', [
    req.params.ticketId,
    importer.id,
  ]);
  const ticket = t.rows[0];
  if (!ticket) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const replies = await pool.query(
    'SELECT * FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticket.id]
  );
  res.json({ ticket: serializeTicket(ticket), replies: replies.rows.map(serializeReply) });
});

const ReplySchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

/**
 * Shared by both the importer-side POST /importers/:id/tickets/:ticketId/replies
 * and the admin-side POST /admin/tickets/:ticketId/replies below — notifies
 * the *other* party (admin reply -> notify the importer; importer reply ->
 * notify the ticket-opening admin) and always writes an audit_log row, per
 * the "tickets are included in the surety_admin audit log" AC.
 */
async function postReply(
  req: Request,
  res: Response,
  ticket: any,
  actorUserId: string,
  body: string
) {
  const reply = await pool.query(
    `INSERT INTO support_ticket_replies (ticket_id, author_user_id, body) VALUES ($1, $2, $3)
     RETURNING *`,
    [ticket.id, actorUserId, body]
  );
  await pool.query(`UPDATE support_tickets SET updated_at = now() WHERE id = $1`, [ticket.id]);

  await logAudit(actorUserId, 'support_ticket_reply', ticket.id, {
    importerId: ticket.importer_id,
  });

  // Notify the other side of the thread. Importer replies notify the admin
  // who opened/most recently handled the ticket isn't tracked per-admin
  // (surety_admin is effectively a shared inbox in this product), so only
  // the importer<-admin direction is notified here.
  if (actorUserId !== ticket.importer_user_id) {
    await createNotification(
      ticket.importer_user_id,
      NOTIFICATION_KINDS.TICKET_REPLY,
      `New reply on your support ticket "${ticket.subject}"`
    ).catch(() => undefined);
  }

  res.status(201).json({ reply: serializeReply(reply.rows[0]) });
}

// POST /importers/:id/tickets/:ticketId/replies
supportTicketsRouter.post(
  '/:id/tickets/:ticketId/replies',
  async (req: Request, res: Response) => {
    const user = (req as AuthedRequest).user;
    const importer = await loadImporterFor(req, String(req.params.id ?? ''));
    if (!importer) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const t = await pool.query(
      'SELECT * FROM support_tickets WHERE id = $1 AND importer_id = $2',
      [req.params.ticketId, importer.id]
    );
    const ticket = t.rows[0];
    if (!ticket) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parse = ReplySchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid input', details: parse.error.issues });
      return;
    }
    await postReply(req, res, { ...ticket, importer_user_id: importer.user_id }, user.id, parse.data.body);
  }
);

// ── Admin-side router, mounted at '/admin' ─────────────────────────────────

export const adminSupportTicketsRouter = Router();
adminSupportTicketsRouter.use(authMiddleware);

function requireSuretyAdmin(req: Request, res: Response): boolean {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'surety admin only' });
    return false;
  }
  return true;
}

// GET /admin/tickets — all tickets across importers, most recently updated first.
adminSupportTicketsRouter.get('/tickets', async (req: Request, res: Response) => {
  if (!requireSuretyAdmin(req, res)) return;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const r = status
    ? await pool.query(
        'SELECT * FROM support_tickets WHERE status = $1 ORDER BY updated_at DESC LIMIT 200',
        [status]
      )
    : await pool.query('SELECT * FROM support_tickets ORDER BY updated_at DESC LIMIT 200');
  res.json({ tickets: r.rows.map(serializeTicket) });
});

// GET /admin/tickets/:ticketId — thread view for admins.
adminSupportTicketsRouter.get('/tickets/:ticketId', async (req: Request, res: Response) => {
  if (!requireSuretyAdmin(req, res)) return;
  const t = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.ticketId]);
  const ticket = t.rows[0];
  if (!ticket) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const replies = await pool.query(
    'SELECT * FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC',
    [ticket.id]
  );
  res.json({ ticket: serializeTicket(ticket), replies: replies.rows.map(serializeReply) });
});

// POST /admin/tickets/:ticketId/replies
adminSupportTicketsRouter.post('/tickets/:ticketId/replies', async (req: Request, res: Response) => {
  if (!requireSuretyAdmin(req, res)) return;
  const user = (req as AuthedRequest).user;
  const t = await pool.query(
    `SELECT t.*, i.user_id AS importer_user_id FROM support_tickets t
     JOIN importers i ON i.id = t.importer_id WHERE t.id = $1`,
    [req.params.ticketId]
  );
  const ticket = t.rows[0];
  if (!ticket) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const parse = ReplySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }
  await postReply(req, res, ticket, user.id, parse.data.body);
});

const StatusSchema = z.object({
  status: z.enum(['open', 'pending', 'closed']),
});

// PATCH /admin/tickets/:ticketId/status
adminSupportTicketsRouter.patch('/tickets/:ticketId/status', async (req: Request, res: Response) => {
  if (!requireSuretyAdmin(req, res)) return;
  const user = (req as AuthedRequest).user;

  const parse = StatusSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }

  const r = await pool.query(
    `UPDATE support_tickets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [parse.data.status, req.params.ticketId]
  );
  const ticket = r.rows[0];
  if (!ticket) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  await logAudit(user.id, 'support_ticket_status_changed', ticket.id, {
    importerId: ticket.importer_id,
    status: parse.data.status,
  });

  const owner = await pool.query('SELECT user_id FROM importers WHERE id = $1', [ticket.importer_id]);
  if (owner.rows[0]?.user_id) {
    await createNotification(
      owner.rows[0].user_id,
      NOTIFICATION_KINDS.TICKET_STATUS_CHANGED,
      `Your support ticket "${ticket.subject}" is now ${parse.data.status}`
    ).catch(() => undefined);
  }

  res.json({ ticket: serializeTicket(ticket) });
});
