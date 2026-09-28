import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, privacyReacceptanceGate, tosReacceptanceGate } from '../auth.js';
import { searchHtsClassifications } from '../services/hts-classification-lookup.js';

// #989 — HTS classification lookup, mounted at '/importers' from index.ts
// (same split-file-same-prefix pattern as routes/kyc.ts) ahead of the
// upload-tariff-csv handler in routes/importers.ts.
export const htsLookupRouter = Router();
htsLookupRouter.use(authMiddleware);
htsLookupRouter.use(privacyReacceptanceGate);
htsLookupRouter.use(tosReacceptanceGate);

const QuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

// GET /importers/hts-lookup?q=... — search by product description or partial HTS code.
// Read-only and cached; never touches required_collateral (that only moves
// once a code is actually used in a submitted CSV via upload-tariff-csv).
htsLookupRouter.get('/hts-lookup', (req: Request, res: Response) => {
  const parse = QuerySchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid query', details: parse.error.issues });
    return;
  }
  const results = searchHtsClassifications(parse.data.q, parse.data.limit);
  res.json({ results });
});
