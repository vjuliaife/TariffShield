'use client';

import { getToken } from './auth';

const BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3002';

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Importer {
  id: string;
  legalName: string;
  ein: string | null;
  bondId: string;
  stellarAddress: string;
  stellarSecret?: string;
  registeredOnChainTx: string | null;
  stellarTxUrl?: string;
  createdAt: string;
  email?: string;
}

export interface OnChainAccount {
  bondId: string;
  collateralBalance: string;
  requiredCollateral: string;
  reserveBalance: string;
  yieldAccrued: string;
  isClawbacked: boolean;
}

export interface ContractEvent {
  id: string;
  kind: string;
  amount: string | null;
  txHash: string;
  txUrl: string | null;
  createdAt: string;
}

export interface ImporterDetail {
  importer: Importer;
  onChainAccount: OnChainAccount;
}

export interface EventsPage {
  data: ContractEvent[];
  nextCursor: string | null;
}

export interface ImporterMetrics {
  totalImporters: number;
  totalBondValue: string;
  avgBalance: string;
  complianceRate: number;
  topupCount30d: number;
  refreshedAt: string;
}

export interface BondAnnotation {
  id: string;
  eventId: string;
  importerId: string;
  authorId: string;
  authorRole: 'importer' | 'surety_admin';
  note: string;
  createdAt: string;
  updatedAt: string;
}

// ── Developer usage dashboard (#1043) ──────────────────────────────────────
export interface UsageBucket {
  windowStart: string;
  requestCount: number;
}

export interface ApiKeyUsageSummary {
  apiKeyId: string | null;
  rateLimitPerMin: number | null;
  currentMinuteCount: number;
  remaining: number | null;
  approachingLimit: boolean;
  last24hByHour: UsageBucket[];
  last30dByDay: UsageBucket[];
  last24hByCategory: { category: string; requestCount: number }[];
}

export interface DeveloperKey {
  id: string;
  prefix: string;
  label: string | null;
  scopes: string[];
  rate_limit_per_min: number | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== false) {
    const t = getToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data?.details);
  return data as T;
}

// One-shot cache for importer detail prefetches: populated on row hover, consumed
// by the first getImporter() call after navigation so the detail page can render
// without waiting on the network. Cleared on read so later refreshes stay fresh.
const importerPrefetchCache = new Map<string, Promise<ImporterDetail>>();

export const api = {
  signup: (b: { email: string; password: string; role: 'importer' | 'surety_admin' }) =>
    request<{ token: string; user: import('./auth').AuthUser }>('/auth/signup', {
      method: 'POST',
      body: b,
      auth: false,
    }),
  login: (b: { email: string; password: string }) =>
    request<{ token: string; user: import('./auth').AuthUser }>('/auth/login', {
      method: 'POST',
      body: b,
      auth: false,
    }),

  createImporter: (b: {
    legalName: string;
    ein?: string;
    bondId: number;
    initialRequiredCollateral: string;
  }) => request<{ importer: Importer }>('/importers', { method: 'POST', body: b }),
  listImporters: () => request<{ importers: Importer[] }>('/importers'),
  getStats: () => request<{ metrics: ImporterMetrics }>('/importers/stats'),
  // #255: cursor-paginated event log — fetched lazily by the dashboard's
  // infinite-scroll section instead of being inlined into getImporter().
  getImporterEventsCursor: (id: string, cursor?: string | null, limit = 20) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return request<EventsPage>(`/importers/${id}/events?${params.toString()}`);
  },
  prefetchImporter: (id: string) => {
    if (importerPrefetchCache.has(id)) return;
    const p = request<ImporterDetail>(`/importers/${id}`);
    importerPrefetchCache.set(id, p);
    p.catch(() => importerPrefetchCache.delete(id));
  },
  getImporter: (id: string) => {
    const cached = importerPrefetchCache.get(id);
    if (cached) {
      importerPrefetchCache.delete(id);
      return cached;
    }
    return request<ImporterDetail>(`/importers/${id}`);
  },
  uploadTariffCsv: (id: string, b: { filename?: string; annualDutyTotal: number }) =>
    request<{
      annualDutyTotal: number;
      bondFaceValue: number;
      requiredCollateralStroops: string;
      txHash: string;
      txUrl: string;
    }>(`/importers/${id}/upload-tariff-csv`, { method: 'POST', body: b }),
  deposit: (id: string, b: { amountStroops: string; bucket: 'collateral' | 'reserve' }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/deposit`, {
      method: 'POST',
      body: b,
    }),
  autoTopUp: (id: string) =>
    request<{ movedStroops: string; txHash: string; txUrl: string }>(
      `/importers/${id}/auto-top-up`,
      { method: 'POST' }
    ),
  withdraw: (id: string, b: { amountStroops: string }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/withdraw`, {
      method: 'POST',
      body: b,
    }),
  accrueYield: (id: string, b: { amountStroops: string }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/accrue-yield`, {
      method: 'POST',
      body: b,
    }),
  clawback: (id: string) =>
    request<{ clawedStroops: string; txHash: string; txUrl: string }>(`/importers/${id}/clawback`, {
      method: 'POST',
    }),

  // ── Bond timeline annotations (#1046) ─────────────────────────────────────
  getEventAnnotations: (eventId: string) =>
    request<{ annotations: BondAnnotation[] }>(`/bond-annotations/event/${eventId}`),
  getImporterAnnotations: (importerId: string) =>
    request<{ annotations: BondAnnotation[] }>(`/bond-annotations/${importerId}`),
  addAnnotation: (b: { event_id: string; importer_id: string; note: string }) =>
    request<{ annotation: BondAnnotation }>('/bond-annotations', { method: 'POST', body: b }),
  updateAnnotation: (id: string, note: string) =>
    request<{ annotation: BondAnnotation }>(`/bond-annotations/${id}`, {
      method: 'PATCH',
      body: { note },
    }),
  deleteAnnotation: (id: string) =>
    request<{ success: boolean }>(`/bond-annotations/${id}`, { method: 'DELETE' }),

  // ── Developer usage dashboard (#1043) ────────────────────────────────────
  developerKeys: () => request<{ keys: DeveloperKey[] }>('/developer/keys'),
  developerUsage: () =>
    request<{ usage: ApiKeyUsageSummary; keyCount: number }>('/developer/usage'),
  developerKeyUsage: (id: string) =>
    request<{ usage: ApiKeyUsageSummary }>(`/developer/keys/${id}/usage`),

  // ── Onboarding drip (#1044) ──────────────────────────────────────────────
  onboardingDrip: () =>
    request<{
      enrolled: boolean;
      enrolledAt?: string;
      completedAt?: string | null;
      unsubscribedAt?: string | null;
      sends: { step_key: string; status: string; sent_at: string; subject: string | null }[];
    }>('/onboarding/drip'),
  onboardingDripUnsubscribe: () =>
    request<{ success: boolean }>('/onboarding/drip/unsubscribe', { method: 'POST' }),
};

export function stroopsToXlm(stroops: string | bigint | number): string {
  const n = typeof stroops === 'string' ? BigInt(stroops) : BigInt(stroops);
  const whole = n / 10000000n;
  const frac = n % 10000000n;
  return `${whole}.${frac.toString().padStart(7, '0').slice(0, 4)}`;
}

/**
 * Formats a raw duty-estimate input value as grouped USD for display only —
 * e.g. '5000000' renders as '$5,000,000'. Returns null when the value is empty
 * or not a finite number so callers can skip the preview rather than showing
 * '$NaN' while the field is being typed into. The underlying input keeps its
 * plain numeric string; nothing here touches submitted payloads.
 */
export function formatUsd(value: string | number): string | null {
  const n = typeof value === 'number' ? value : Number(value.trim());
  if (typeof value === 'string' && value.trim() === '') return null;
  if (!Number.isFinite(n)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    // Whole dollar amounts (the common case for a duty estimate) render as
    // '$5,000,000' rather than '$5,000,000.00'; cents still show when entered.
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}
