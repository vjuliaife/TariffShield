import { z } from 'zod';

// Issue #998 — white-label branding types, defaults and validation. Kept free
// of DB/env imports so it can be unit-tested and shared by the route.

export interface Branding {
  slug: string | null;
  brandName: string;
  logoDataUrl: string | null;
  primaryColor: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  slug: null,
  brandName: 'TariffShield',
  logoDataUrl: null,
  primaryColor: null,
};

// ~150 KB of decoded image data; base64 inflates by 4/3.
export const MAX_LOGO_DATA_URL_LENGTH = 200_000;
const LOGO_DATA_URL_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const BrandingSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'slug must be 1-40 lowercase letters, digits or dashes'),
  brandName: z.string().trim().min(1).max(60).nullable().optional(),
  logoDataUrl: z
    .string()
    .max(MAX_LOGO_DATA_URL_LENGTH, 'logo must be under ~150 KB')
    .regex(LOGO_DATA_URL_RE, 'logo must be a base64 PNG, JPEG, WebP or SVG data URL')
    .nullable()
    .optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'primaryColor must be a #RRGGBB hex colour')
    .nullable()
    .optional(),
});
