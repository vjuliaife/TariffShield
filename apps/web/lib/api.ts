"use client";

import { getToken } from "./auth";

const BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) ||
  "http://localhost:3002";

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
  events?: ContractEvent[];
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

async function request<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.auth !== false) {
    const t = getToken();
    if (t) headers["Authorization"] = `Bearer ${t}`;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
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
  signup: (b: { email: string; password: string; role: "importer" | "surety_admin" }) =>
    request<{ token: string; user: import("./auth").AuthUser }>("/auth/signup", { method: "POST", body: b, auth: false }),
  login: (b: { email: string; password: string }) =>
    request<{ token: string; user: import("./auth").AuthUser }>("/auth/login", { method: "POST", body: b, auth: false }),

  createImporter: (b: { legalName: string; ein?: string; bondId: number; initialRequiredCollateral: string }) =>
    request<{ importer: Importer }>("/importers", { method: "POST", body: b }),
  listImporters: () => request<{ importers: Importer[] }>("/importers"),
  getStats: () => request<{ metrics: ImporterMetrics }>("/importers/stats"),
  // #255: cursor-paginated event log — fetched lazily by the dashboard's
  // infinite-scroll section instead of being inlined into getImporter().
  getImporterEventsCursor: (id: string, cursor?: string | null, limit = 20) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
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
    request<{ annualDutyTotal: number; bondFaceValue: number; requiredCollateralStroops: string; txHash: string; txUrl: string }>(
      `/importers/${id}/upload-tariff-csv`, { method: "POST", body: b },
    ),
  deposit: (id: string, b: { amountStroops: string; bucket: "collateral" | "reserve" }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/deposit`, { method: "POST", body: b }),
  autoTopUp: (id: string) =>
    request<{ movedStroops: string; txHash: string; txUrl: string }>(`/importers/${id}/auto-top-up`, { method: "POST" }),
  withdraw: (id: string, b: { amountStroops: string }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/withdraw`, { method: "POST", body: b }),
  accrueYield: (id: string, b: { amountStroops: string }) =>
    request<{ txHash: string; txUrl: string }>(`/importers/${id}/accrue-yield`, { method: "POST", body: b }),
  clawback: (id: string) =>
    request<{ clawedStroops: string; txHash: string; txUrl: string }>(`/importers/${id}/clawback`, { method: "POST" }),
};

export function stroopsToXlm(stroops: string | bigint | number): string {
  const n = typeof stroops === "string" ? BigInt(stroops) : BigInt(stroops);
  const whole = n / 10000000n;
  const frac = n % 10000000n;
  return `${whole}.${frac.toString().padStart(7, "0").slice(0, 4)}`;
}
