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

/**
 * Surety Partner Rate Comparison Marketplace (#1036)
 *
 * Routes for importers to browse and compare surety partners before onboarding.
 * Admin routes for managing marketplace partner listings.
 */
export const suretyMarketplaceRouter = Router();

// Public/importer routes
suretyMarketplaceRouter.use(authMiddleware);
suretyMarketplaceRouter.use(privacyReacceptanceGate);
suretyMarketplaceRouter.use(tosReacceptanceGate);

// GET /api/v1/surety-marketplace — list available surety partners
suretyMarketplaceRouter.get('/', async (req: Request, res: Response) => {
  const query = z
    .object({
      min_collateral_ratio: z.coerce.number().positive().optional(),
      max_collateral_ratio: z.coerce.number().positive().optional(),
      coverage_type: z.enum(['continuous', 'single_entry', 'term']).optional(),
      state_licensed: z.string().length(2).optional(), // State code filter
      sort: z.enum(['collateral_ratio', 'rating', 'name']).default('collateral_ratio'),
    })
    .safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: 'invalid query parameters' });
    return;
  }

  const { min_collateral_ratio, max_collateral_ratio, coverage_type, state_licensed, sort } =
    query.data;

  const conditions: string[] = ['sp.is_active = TRUE', 'sp.is_published = TRUE'];
  const params: unknown[] = [];
  let idx = 1;

  if (min_collateral_ratio) {
    conditions.push(`sp.collateral_ratio >= $${idx++}`);
    params.push(min_collateral_ratio);
  }
  if (max_collateral_ratio) {
    conditions.push(`sp.collateral_ratio <= $${idx++}`);
    params.push(max_collateral_ratio);
  }
  if (coverage_type) {
    conditions.push(`$${idx++} = ANY(sp.coverage_types)`);
    params.push(coverage_type);
  }
  if (state_licensed) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM surety_state_licenses ssl
        WHERE ssl.surety_id = sp.surety_id AND ssl.state_code = $${idx++}
      )`
    );
    params.push(state_licensed);
  }

  const where = conditions.join(' AND ');
  let orderBy = 'sp.collateral_ratio ASC';
  if (sort === 'rating') {
    orderBy = 'sp.am_best_rating DESC NULLS LAST, sp.collateral_ratio ASC';
  } else if (sort === 'name') {
    orderBy = 'sp.company_name ASC';
  }

  const partners = await pool.query(
    `SELECT sp.id, sp.company_name, sp.collateral_ratio, sp.coverage_types,
            sp.am_best_rating, sp.naic_number, sp.base_premium_rate,
            sp.description, sp.min_bond_amount, sp.max_bond_amount,
            sp.states_licensed_count, sp.created_at, sp.updated_at
     FROM surety_marketplace_partners sp
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT 50`,
    params
  );

  res.json({
    partners: partners.rows,
    disclaimer:
      'This marketplace provides informational rate comparisons only. Rates shown are indicative and not binding quotes. Contact the surety partner directly for official quotes and terms.',
  });
});

// GET /api/v1/surety-marketplace/:id — get details for a specific partner
suretyMarketplaceRouter.get('/:id', async (req: Request, res: Response) => {
  const partner = await pool.query(
    `SELECT sp.id, sp.surety_id, sp.company_name, sp.collateral_ratio,
            sp.coverage_types, sp.am_best_rating, sp.naic_number,
            sp.base_premium_rate, sp.description, sp.min_bond_amount,
            sp.max_bond_amount, sp.states_licensed_count,
            sp.contact_email, sp.contact_phone, sp.website_url,
            sp.stellar_contract_address, sp.created_at, sp.updated_at,
            (SELECT array_agg(state_code ORDER BY state_code)
             FROM surety_state_licenses
             WHERE surety_id = sp.surety_id) AS licensed_states
     FROM surety_marketplace_partners sp
     WHERE sp.id = $1 AND sp.is_active = TRUE AND sp.is_published = TRUE`,
    [req.params.id]
  );

  if (!partner.rowCount) {
    res.status(404).json({ error: 'surety partner not found' });
    return;
  }

  res.json({
    partner: partner.rows[0],
    disclaimer:
      'This information is provided for comparison purposes. Verify all details and obtain an official quote directly from the surety partner.',
  });
});

// Admin routes for managing marketplace listings
const adminMarketplaceRouter = Router();
adminMarketplaceRouter.use(authMiddleware);
adminMarketplaceRouter.use(privacyReacceptanceGate);
adminMarketplaceRouter.use(tosReacceptanceGate);
adminMarketplaceRouter.use(requireRole('surety_admin'));

// POST /api/v1/surety-marketplace/admin — create or update marketplace listing
adminMarketplaceRouter.post('/admin', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z
    .object({
      collateral_ratio: z.number().positive(),
      coverage_types: z.array(z.enum(['continuous', 'single_entry', 'term'])),
      base_premium_rate: z.number().positive(),
      description: z.string().max(500),
      min_bond_amount: z.number().positive(),
      max_bond_amount: z.number().positive(),
      contact_email: z.string().email(),
      contact_phone: z.string().optional(),
      website_url: z.string().url().optional(),
      stellar_contract_address: z.string().optional(),
    })
    .safeParse(req.body);

  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error });
    return;
  }

  // Get surety company details from verification record
  const verification = await pool.query(
    `SELECT company_name, naic_number, am_best_rating
     FROM surety_license_verifications
     WHERE user_id = $1 AND status = 'verified'`,
    [user.id]
  );

  if (!verification.rowCount) {
    res.status(403).json({ error: 'surety license not verified' });
    return;
  }

  const { company_name, naic_number, am_best_rating } = verification.rows[0] as {
    company_name: string;
    naic_number: string;
    am_best_rating: string;
  };

  // Count licensed states
  const statesCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM surety_state_licenses WHERE surety_id = $1`,
    [user.id]
  );

  const result = await pool.query(
    `INSERT INTO surety_marketplace_partners
       (surety_id, company_name, naic_number, am_best_rating, collateral_ratio,
        coverage_types, base_premium_rate, description, min_bond_amount, max_bond_amount,
        states_licensed_count, contact_email, contact_phone, website_url,
        stellar_contract_address, is_active, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, FALSE)
     ON CONFLICT (surety_id) DO UPDATE SET
       collateral_ratio = EXCLUDED.collateral_ratio,
       coverage_types = EXCLUDED.coverage_types,
       base_premium_rate = EXCLUDED.base_premium_rate,
       description = EXCLUDED.description,
       min_bond_amount = EXCLUDED.min_bond_amount,
       max_bond_amount = EXCLUDED.max_bond_amount,
       states_licensed_count = EXCLUDED.states_licensed_count,
       contact_email = EXCLUDED.contact_email,
       contact_phone = EXCLUDED.contact_phone,
       website_url = EXCLUDED.website_url,
       stellar_contract_address = EXCLUDED.stellar_contract_address,
       updated_at = now()
     RETURNING id, surety_id, company_name, collateral_ratio, is_published`,
    [
      user.id,
      company_name,
      naic_number,
      am_best_rating,
      parse.data.collateral_ratio,
      parse.data.coverage_types,
      parse.data.base_premium_rate,
      parse.data.description,
      parse.data.min_bond_amount,
      parse.data.max_bond_amount,
      parseInt(statesCount.rows[0]?.count ?? '0', 10),
      parse.data.contact_email,
      parse.data.contact_phone ?? null,
      parse.data.website_url ?? null,
      parse.data.stellar_contract_address ?? null,
    ]
  );

  res.status(201).json({
    partner: result.rows[0],
    message: 'Marketplace listing created. Submit for review to publish.',
  });
});

// GET /api/v1/surety-marketplace/admin/my-listing — get own marketplace listing
adminMarketplaceRouter.get('/admin/my-listing', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const listing = await pool.query(
    `SELECT * FROM surety_marketplace_partners WHERE surety_id = $1`,
    [user.id]
  );

  if (!listing.rowCount) {
    res.status(404).json({ error: 'no marketplace listing found' });
    return;
  }

  res.json({ listing: listing.rows[0] });
});

// PUT /api/v1/surety-marketplace/admin/publish — toggle publish status
adminMarketplaceRouter.put('/admin/publish', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = z.object({ is_published: z.boolean() }).safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }

  const result = await pool.query(
    `UPDATE surety_marketplace_partners
     SET is_published = $1, updated_at = now()
     WHERE surety_id = $2
     RETURNING id, is_published`,
    [parse.data.is_published, user.id]
  );

  if (!result.rowCount) {
    res.status(404).json({ error: 'no marketplace listing found' });
    return;
  }

  res.json({ success: true, listing: result.rows[0] });
});

export { adminMarketplaceRouter };
