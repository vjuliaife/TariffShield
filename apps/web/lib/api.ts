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

  // ── Dual Sign-Off Approvals (#1038) ───────────────────────────────────────
  getDualApprovalConfig: (importerId: string) =>
    request<DualApprovalConfig>(`/importers/${importerId}/dual-approval`),
  updateDualApprovalConfig: (importerId: string, b: Partial<DualApprovalConfig>) =>
    request<DualApprovalConfig>(`/importers/${importerId}/dual-approval`, {
      method: 'PUT',
      body: b,
    }),
  listWithdrawalRequests: (importerId: string) =>
    request<{ requests: WithdrawalRequest[] }>(`/importers/${importerId}/withdrawal-requests`),
  approveWithdrawalRequest: (importerId: string, requestId: string) =>
    request<{ status: string; jobId?: string; statusUrl?: string }>(
      `/importers/${importerId}/withdrawal-requests/${requestId}/approve`,
      { method: 'POST' }
    ),
  rejectWithdrawalRequest: (importerId: string, requestId: string, reason?: string) =>
    request<{ status: string }>(
      `/importers/${importerId}/withdrawal-requests/${requestId}/reject`,
      { method: 'POST', body: { reason } }
    ),
  cancelWithdrawalRequest: (importerId: string, requestId: string) =>
    request<{ status: string }>(
      `/importers/${importerId}/withdrawal-requests/${requestId}/cancel`,
      { method: 'POST' }
    ),

  // ── Bulk HS Code Mappings (#1040) ─────────────────────────────────────────
  uploadSkuMappingsBulk: (
    importerId: string,
    b: {
      mappings?: Array<{ sku: string; htsCode: string; description?: string; dutyRate?: number }>;
      csvText?: string;
    }
  ) =>
    request<{ success: boolean; version: number; count: number }>(
      `/importers/${importerId}/sku-mappings/bulk`,
      { method: 'POST', body: b }
    ),
  listSkuMappings: (
    importerId: string,
    query?: { search?: string; version?: number; page?: number; per_page?: number }
  ) => {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.version) params.set('version', String(query.version));
    if (query?.page) params.set('page', String(query.page));
    if (query?.per_page) params.set('per_page', String(query.per_page));
    return request<SkuMappingsPage>(`/importers/${importerId}/sku-mappings?${params.toString()}`);
  },
  createSkuMapping: (
    importerId: string,
    mapping: { sku: string; htsCode: string; description?: string; dutyRate?: number }
  ) =>
    request<{ mapping: SkuMapping }>(`/importers/${importerId}/sku-mappings`, {
      method: 'POST',
      body: mapping,
    }),
  updateSkuMapping: (
    importerId: string,
    mappingId: string,
    mapping: { sku: string; htsCode: string; description?: string; dutyRate?: number }
  ) =>
    request<{ mapping: SkuMapping }>(`/importers/${importerId}/sku-mappings/${mappingId}`, {
      method: 'PUT',
      body: mapping,
    }),
  deleteSkuMapping: (importerId: string, mappingId: string) =>
    request<{ success: boolean }>(`/importers/${importerId}/sku-mappings/${mappingId}`, {
      method: 'DELETE',
    }),

  // ── Compliance Document Expiration Calendar (#1041) ───────────────────────
  getComplianceCalendar: (importerId: string) =>
    request<{ items: ComplianceExpirationItem[] }>(`/importers/${importerId}/compliance-calendar`),

  // ── Admin Audit Log Search & Filter (#1039) ───────────────────────────────
  getAuditLog: (query?: {
    actor_user_id?: string;
    action?: string;
    from?: string;
    to?: string;
    search?: string;
    page?: number;
    per_page?: number;
  }) => {
    const params = new URLSearchParams();
    if (query?.actor_user_id) params.set('actor_user_id', query.actor_user_id);
    if (query?.action) params.set('action', query.action);
    if (query?.from) params.set('from', query.from);
    if (query?.to) params.set('to', query.to);
    if (query?.search) params.set('search', query.search);
    if (query?.page) params.set('page', String(query.page));
    if (query?.per_page) params.set('per_page', String(query.per_page));
    return request<AuditLogPage>(`/admin/audit-log?${params.toString()}`);
  },
  // ── NPS/Feedback Survey (#1035) ───────────────────────────────────────────
  npsPromptStatus: () =>
    request<{ shouldShow: boolean; cadenceDays: number; lastShownAt: string | null }>(
      '/nps/prompt-status'
    ),
  npsDismiss: () => request<{ success: boolean }>('/nps/dismiss', { method: 'POST' }),
  npsRespond: (score: number, comment?: string) =>
    request<{ success: boolean }>('/nps/respond', { method: 'POST', body: { score, comment } }),
  npsAdminTrend: () => request<{ trend: NpsTrendPoint[] }>('/nps/admin/trend'),

  // ── Branded Report Export Templates (#1032) ───────────────────────────────
  getReportTemplate: () =>
    request<{ template: ReportTemplate; isDefault: boolean }>('/report-templates'),
  saveReportTemplate: (b: Partial<ReportTemplate>) =>
    request<{ template: ReportTemplate }>('/report-templates', { method: 'PUT', body: b }),

  getAuditLogCsvUrl: (query?: {
    actor_user_id?: string;
    action?: string;
    from?: string;
    to?: string;
    search?: string;
  }) => {
    const params = new URLSearchParams({ format: 'csv' });
    if (query?.actor_user_id) params.set('actor_user_id', query.actor_user_id);
    if (query?.action) params.set('action', query.action);
    if (query?.from) params.set('from', query.from);
    if (query?.to) params.set('to', query.to);
    if (query?.search) params.set('search', query.search);
    return `${BASE}/admin/audit-log?${params.toString()}`;
  },
};

export interface DualApprovalConfig {
  enabled: boolean;
  thresholdStroops: string;
  secondApproverId: string | null;
  secondApproverEmail: string | null;
}

export interface WithdrawalRequest {
  id: string;
  importer_id: string;
  requested_by: string;
  requested_by_email: string | null;
  amount_stroops: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  second_approver_id: string | null;
  second_approver_email: string | null;
  approved_by: string | null;
  approved_by_email: string | null;
  rejected_by: string | null;
  rejected_by_email: string | null;
  rejection_reason: string | null;
  job_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SkuMapping {
  id: string;
  importer_id: string;
  version: number;
  sku: string;
  hts_code: string;
  description: string | null;
  duty_rate: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkuMappingsPage {
  mappings: SkuMapping[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

export interface ComplianceExpirationItem {
  id: string;
  entityType: 'kyc' | 'surety_license';
  title: string;
  documentType: string;
  expirationDate: string;
  daysUntilExpiration: number;
  urgency: 'critical' | 'warning' | 'upcoming' | 'normal';
  deepLink: string;
  metadata?: Record<string, unknown>;
}

export interface NpsTrendPoint {
  weekStart: string;
  promoters: number;
  passives: number;
  detractors: number;
  total: number;
  nps: number;
}

export interface ReportTemplate {
  logoUrl: string | null;
  headerText: string | null;
  footerText: string | null;
}

export interface AuditLogEntry {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface AuditLogPage {
  data: AuditLogEntry[];
  pagination: {
    total: number;
    page: number;
    per_page: number;
    total_pages: number;
  };
}

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
