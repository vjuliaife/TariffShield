'use client';

import { useEffect, useState } from 'react';
import { api, type Branding } from './api';
import { getUser } from './auth';

// Issue #998 — white-label branding per surety/partner tenant.
//
// Resolution order at render time:
//   1. a signed-in surety_admin sees their own tenant's branding;
//   2. anyone else who arrived via a partner link (?brand=<slug>) sees that
//      partner's branding — the slug is remembered in localStorage;
//   3. otherwise the default TariffShield branding.
// Branding is fetched from the API on each load, so admin edits apply
// without a redeploy.

export const DEFAULT_BRANDING: Branding = {
  slug: null,
  brandName: 'TariffShield',
  logoDataUrl: null,
  primaryColor: null,
};

export const BRAND_SLUG_STORAGE_KEY = 'tariffshield.brand';
export const BRANDING_CHANGED_EVENT = 'tariffshield:branding-changed';

function readStoredSlug(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('brand');
    if (fromUrl) {
      window.localStorage.setItem(BRAND_SLUG_STORAGE_KEY, fromUrl.toLowerCase());
      return fromUrl.toLowerCase();
    }
    return window.localStorage.getItem(BRAND_SLUG_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Pick black or white text for legibility on top of `hex`.
export function contrastingForeground(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#0a0e1a' : '#ffffff';
}

// Overrides the --accent tokens from globals.css so every bg-accent /
// text-accent utility picks up the partner colour. Clearing restores the
// stylesheet defaults for both light and dark themes.
export function applyBrandColor(primaryColor: string | null) {
  const style = document.documentElement.style;
  if (primaryColor) {
    style.setProperty('--accent', primaryColor);
    style.setProperty('--accent-foreground', contrastingForeground(primaryColor));
  } else {
    style.removeProperty('--accent');
    style.removeProperty('--accent-foreground');
  }
}

async function resolveBranding(): Promise<Branding> {
  const user = getUser();
  if (user?.role === 'surety_admin') {
    return (await api.getBranding()).branding;
  }
  const slug = readStoredSlug();
  if (slug) {
    return (await api.getPublicBranding(slug)).branding;
  }
  return DEFAULT_BRANDING;
}

export function notifyBrandingChanged(branding: Branding) {
  window.dispatchEvent(new CustomEvent<Branding>(BRANDING_CHANGED_EVENT, { detail: branding }));
}

export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);

  useEffect(() => {
    let cancelled = false;
    resolveBranding()
      .then((b) => {
        if (!cancelled) setBranding(b);
      })
      .catch(() => {
        // Any lookup failure falls back to the default branding.
      });
    const onChange = (e: Event) => setBranding((e as CustomEvent<Branding>).detail);
    window.addEventListener(BRANDING_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(BRANDING_CHANGED_EVENT, onChange);
    };
  }, []);

  useEffect(() => {
    applyBrandColor(branding.primaryColor);
    document.title = document.title.replace(/^[^—]+—/, `${branding.brandName} —`);
  }, [branding]);

  return branding;
}
