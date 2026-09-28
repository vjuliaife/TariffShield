'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type Branding } from '@/lib/api';
import { applyBrandColor, DEFAULT_BRANDING, notifyBrandingChanged } from '@/lib/branding';

// Issue #998 — white-label branding admin: partner name, logo and primary
// colour for this surety tenant. Saved values are served by the API at render
// time, so the Nav and dashboard shell pick them up without a redeploy.

const MAX_LOGO_BYTES = 150 * 1024;
const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

interface Draft {
  slug: string;
  brandName: string;
  logoDataUrl: string | null;
  primaryColor: string | null;
}

function toDraft(b: Branding): Draft {
  return {
    slug: b.slug ?? '',
    brandName: b.brandName === DEFAULT_BRANDING.brandName && !b.slug ? '' : b.brandName,
    logoDataUrl: b.logoDataUrl,
    primaryColor: b.primaryColor,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function BrandingEditor() {
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(toDraft(DEFAULT_BRANDING));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    api
      .getBranding()
      .then((r) => setDraft(toDraft(r.branding)))
      .catch(() => setError('Could not load branding settings.'))
      .finally(() => setLoaded(true));
  }, []);

  async function handleLogo(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setError('Logo must be a PNG, JPEG, WebP or SVG image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logo must be under 150 KB.');
      return;
    }
    setError(null);
    const dataUrl = await readFileAsDataUrl(file);
    setDraft((d) => ({ ...d, logoDataUrl: dataUrl }));
  }

  function setColor(primaryColor: string | null) {
    setDraft((d) => ({ ...d, primaryColor }));
    applyBrandColor(primaryColor); // live preview across the page
  }

  async function handleSave() {
    setStatus('saving');
    setError(null);
    try {
      const r = await api.saveBranding({
        slug: draft.slug.trim().toLowerCase(),
        brandName: draft.brandName.trim() || null,
        logoDataUrl: draft.logoDataUrl,
        primaryColor: draft.primaryColor,
      });
      setDraft(toDraft(r.branding));
      notifyBrandingChanged(r.branding);
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save branding.');
      setStatus('idle');
    }
  }

  async function handleReset() {
    setStatus('saving');
    setError(null);
    try {
      const r = await api.resetBranding();
      setDraft(toDraft(r.branding));
      notifyBrandingChanged(r.branding);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to reset branding.');
    } finally {
      setStatus('idle');
    }
  }

  const partnerLink = draft.slug && origin ? `${origin}/signup?brand=${draft.slug}` : null;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">White-label branding</h3>
      <p className="mt-1 text-xs text-muted">
        Your name, logo and colour replace the TariffShield branding in the navigation and
        dashboards for you and importers who join via your partner link. Unset fields fall back to
        the default branding. {loaded ? null : 'Loading…'}
      </p>

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="block text-xs text-muted">Partner slug (used in your partner link)</span>
          <input
            type="text"
            value={draft.slug}
            maxLength={40}
            onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value.toLowerCase() }))}
            placeholder="acme-surety"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="block text-xs text-muted">Brand name</span>
          <input
            type="text"
            value={draft.brandName}
            maxLength={60}
            onChange={(e) => setDraft((d) => ({ ...d, brandName: e.target.value }))}
            placeholder={DEFAULT_BRANDING.brandName}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        <div>
          <span className="block text-xs text-muted">
            Logo (PNG, JPEG, WebP or SVG, max 150 KB)
          </span>
          <div className="mt-1 flex items-center gap-3">
            {draft.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL preview
              <img
                src={draft.logoDataUrl}
                alt="Logo preview"
                className="h-8 w-auto max-w-[120px] rounded border border-border object-contain"
              />
            ) : (
              <span className="text-xs text-muted">No logo — default mark shown</span>
            )}
            <input
              type="file"
              accept={ACCEPTED_LOGO_TYPES.join(',')}
              onChange={(e) => handleLogo(e.target.files?.[0])}
              className="text-xs"
            />
            {draft.logoDataUrl ? (
              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, logoDataUrl: null }))}
                className="text-xs text-muted underline hover:text-foreground"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>

        <div>
          <span className="block text-xs text-muted">Primary colour</span>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="color"
              value={draft.primaryColor ?? '#0284c7'}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Primary colour"
              className="h-8 w-12 cursor-pointer rounded border border-border bg-background"
            />
            <span className="font-mono text-xs">{draft.primaryColor ?? 'default'}</span>
            {draft.primaryColor ? (
              <button
                type="button"
                onClick={() => setColor(null)}
                className="text-xs text-muted underline hover:text-foreground"
              >
                Use default
              </button>
            ) : null}
          </div>
        </div>

        {partnerLink ? (
          <p className="text-xs text-muted">
            Partner link: <span className="font-mono text-foreground break-all">{partnerLink}</span>
          </p>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={status === 'saving' || !draft.slug}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : 'Save branding'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          disabled={status === 'saving'}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-background disabled:opacity-50"
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
