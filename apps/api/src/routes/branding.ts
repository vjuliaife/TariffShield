import { Router, type Request, type Response } from 'express';
import { pool } from '../db.js';
import {
  authMiddleware,
  requireRole,
  privacyReacceptanceGate,
  tosReacceptanceGate,
  type AuthedRequest,
} from '../auth.js';
import { BrandingSchema, DEFAULT_BRANDING, SLUG_RE, type Branding } from '../lib/branding.js';

// Issue #998 — white-label branding per surety/partner tenant. Brokers and
// sureties reselling TariffShield can set their own name, logo and primary
// colour; the web Nav and dashboard shell fetch this at render time, so a
// change is visible on the next page load without a redeploy.

interface BrandingRow {
  slug: string;
  brand_name: string | null;
  logo_data_url: string | null;
  primary_color: string | null;
}

function toBranding(r: BrandingRow): Branding {
  return {
    slug: r.slug,
    brandName: r.brand_name ?? DEFAULT_BRANDING.brandName,
    logoDataUrl: r.logo_data_url ?? DEFAULT_BRANDING.logoDataUrl,
    primaryColor: r.primary_color ?? DEFAULT_BRANDING.primaryColor,
  };
}

const COLUMNS = 'slug, brand_name, logo_data_url, primary_color';

export async function getBrandingForSurety(suretyId: string): Promise<Branding | null> {
  const r = await pool.query<BrandingRow>(
    `SELECT ${COLUMNS} FROM tenant_branding WHERE surety_id = $1`,
    [suretyId]
  );
  return r.rowCount === 0 ? null : toBranding(r.rows[0]!);
}

export async function getBrandingBySlug(slug: string): Promise<Branding | null> {
  const r = await pool.query<BrandingRow>(
    `SELECT ${COLUMNS} FROM tenant_branding WHERE slug = $1`,
    [slug]
  );
  return r.rowCount === 0 ? null : toBranding(r.rows[0]!);
}

// ── Public lookup ────────────────────────────────────────────────────────────
// Unauthenticated so partner-branded login/signup pages (?brand=<slug>) can
// render before a session exists. Only presentation fields are exposed.
export const brandingPublicRouter = Router();

brandingPublicRouter.get('/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const branding = SLUG_RE.test(slug) ? await getBrandingBySlug(slug) : null;
  // Short cache so edits propagate within a minute without a redeploy.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ branding: branding ?? DEFAULT_BRANDING, isDefault: branding === null });
});

// ── Tenant admin ─────────────────────────────────────────────────────────────
export const brandingRouter = Router();
brandingRouter.use(authMiddleware);
brandingRouter.use(privacyReacceptanceGate);
brandingRouter.use(tosReacceptanceGate);
brandingRouter.use(requireRole('surety_admin'));

// GET /branding — the current tenant's branding, falling back to the default.
brandingRouter.get('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const branding = await getBrandingForSurety(user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ branding: branding ?? DEFAULT_BRANDING, isDefault: branding === null });
});

// PUT /branding — upsert the tenant's branding.
brandingRouter.put('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;

  const parse = BrandingSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid branding fields', details: parse.error.issues });
    return;
  }
  const { slug, brandName, logoDataUrl, primaryColor } = parse.data;

  try {
    const result = await pool.query<BrandingRow>(
      `INSERT INTO tenant_branding (surety_id, slug, brand_name, logo_data_url, primary_color)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (surety_id) DO UPDATE
         SET slug = $2, brand_name = $3, logo_data_url = $4, primary_color = $5, updated_at = now()
       RETURNING ${COLUMNS}`,
      [user.id, slug, brandName ?? null, logoDataUrl ?? null, primaryColor?.toLowerCase() ?? null]
    );
    res.json({ branding: toBranding(result.rows[0]!) });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'slug is already taken by another partner' });
      return;
    }
    throw err;
  }
});

// DELETE /branding — reset to the default TariffShield branding.
brandingRouter.delete('/', async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  await pool.query(`DELETE FROM tenant_branding WHERE surety_id = $1`, [user.id]);
  res.json({ branding: DEFAULT_BRANDING, isDefault: true });
});
