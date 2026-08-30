import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import {
  authMiddleware,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';

export const bondAnnotationsRouter = Router();
bondAnnotationsRouter.use(authMiddleware);
bondAnnotationsRouter.use(privacyReacceptanceGate);
bondAnnotationsRouter.use(tosReacceptanceGate);

// POST /bond-annotations — add an annotation to a timeline event
bondAnnotationsRouter.post('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      event_id: z.string().uuid(),
      importer_id: z.string().uuid(),
      note: z.string().min(1).max(2000),
    })
    .safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'event_id, importer_id, and note are required' });
    return;
  }

  const { event_id, importer_id, note } = parse.data;

  // Determine role and verify access
  const isSuretyAdmin = user.role === 'surety_admin';
  const isImporter = user.role === 'importer';

  if (!isSuretyAdmin && !isImporter) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }

  // For importers, verify they own the importer record
  if (isImporter) {
    const importer = await pool.query(`SELECT id FROM importers WHERE id = $1 AND user_id = $2`, [
      importer_id,
      user.id,
    ]);
    if (!importer.rowCount) {
      res.status(403).json({ error: 'unauthorized' });
      return;
    }
  }

  // Get surety_id from the importer
  const importerResult = await pool.query(`SELECT surety_id FROM importers WHERE id = $1`, [
    importer_id,
  ]);
  const suretyId = importerResult.rows[0]?.surety_id;
  if (!suretyId) {
    res.status(404).json({ error: 'importer not found' });
    return;
  }

  const authorRole = isSuretyAdmin ? 'surety_admin' : 'importer';

  const result = await pool.query(
    `INSERT INTO bond_timeline_annotations (event_id, importer_id, surety_id, author_id, author_role, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, event_id, importer_id, author_id, author_role, note, created_at, updated_at`,
    [event_id, importer_id, suretyId, user.id, authorRole, note]
  );

  res.status(201).json({ annotation: result.rows[0] });
});

// GET /bond-annotations/:importerId — list annotations for an importer
bondAnnotationsRouter.get('/:importerId', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const importerId = String(req.params.importerId);

  // Verify access
  const isSuretyAdmin = user.role === 'surety_admin';
  const isImporter = user.role === 'importer';

  if (!isSuretyAdmin && !isImporter) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }

  if (isImporter) {
    const importer = await pool.query(`SELECT id FROM importers WHERE id = $1 AND user_id = $2`, [
      importerId,
      user.id,
    ]);
    if (!importer.rowCount) {
      res.status(403).json({ error: 'unauthorized' });
      return;
    }
  }

  const result = await pool.query(
    `SELECT id, event_id, importer_id, author_id, author_role, note, created_at, updated_at
     FROM bond_timeline_annotations
     WHERE importer_id = $1
     ORDER BY created_at DESC`,
    [importerId]
  );

  res.json({ annotations: result.rows });
});

// GET /bond-annotations/event/:eventId — list annotations for a specific event
bondAnnotationsRouter.get('/event/:eventId', async (req: Request, res: Response) => {
  const eventId = String(req.params.eventId);

  const result = await pool.query(
    `SELECT id, event_id, importer_id, author_id, author_role, note, created_at, updated_at
     FROM bond_timeline_annotations
     WHERE event_id = $1
     ORDER BY created_at DESC`,
    [eventId]
  );

  res.json({ annotations: result.rows });
});

// PATCH /bond-annotations/:id — edit an annotation (author or surety_admin only)
bondAnnotationsRouter.patch('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ note: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'note is required' });
    return;
  }

  const annotationId = String(req.params.id);

  // Check ownership or admin role
  const existing = await pool.query(
    `SELECT id, author_id FROM bond_timeline_annotations WHERE id = $1`,
    [annotationId]
  );

  if (!existing.rowCount) {
    res.status(404).json({ error: 'annotation not found' });
    return;
  }

  const annotation = existing.rows[0]!;
  const isAuthor = annotation.author_id === user.id;
  const isAdmin = user.role === 'surety_admin';

  if (!isAuthor && !isAdmin) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }

  const result = await pool.query(
    `UPDATE bond_timeline_annotations
     SET note = $1, updated_at = now()
     WHERE id = $2
     RETURNING id, event_id, importer_id, author_id, author_role, note, created_at, updated_at`,
    [parse.data.note.trim(), annotationId]
  );

  res.json({ annotation: result.rows[0] });
});

// DELETE /bond-annotations/:id — delete an annotation (author or surety_admin only)
bondAnnotationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const annotationId = String(req.params.id);

  const existing = await pool.query(
    `SELECT id, author_id FROM bond_timeline_annotations WHERE id = $1`,
    [annotationId]
  );

  if (!existing.rowCount) {
    res.status(404).json({ error: 'annotation not found' });
    return;
  }

  const annotation = existing.rows[0]!;
  const isAuthor = annotation.author_id === user.id;
  const isAdmin = user.role === 'surety_admin';

  if (!isAuthor && !isAdmin) {
    res.status(403).json({ error: 'unauthorized' });
    return;
  }

  await pool.query(`DELETE FROM bond_timeline_annotations WHERE id = $1`, [annotationId]);

  res.json({ success: true });
});
