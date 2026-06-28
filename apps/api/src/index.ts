import "./tracing.js";
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express, { type NextFunction, type Request, type Response } from "express";
import { openApiSpec } from "./docs/openapi.js";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import client from "prom-client";
import { env, isProduction } from "./config/env.js";
import { migrate } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { importersRouter } from "./routes/importers.js";
import { adminRouter } from "./routes/admin.js";
import { privacyRouter } from "./routes/privacy.js";
import { bondSignaturesRouter, bondWebhookRouter } from "./routes/bond-signatures.js";
import { startIndexer } from "./indexer.js";
import { ping } from "./db.js";
import { pingRpc } from "./stellar.js";
import { startReconciliationJob } from "./jobs/reconcile-balances.js";
import { startOracleMonitor } from "./services/oracle-monitor.js";
import { privacyReacceptanceGate } from "./auth.js";
import { complianceRouter } from "./routes/compliance.js";
import { kycRouter } from "./routes/kyc.js";
import { startComplianceReportScheduler } from "./jobs/compliance-report.js";
import { suretyLicenseRouter } from "./routes/surety-license.js";

const app = express();

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests processed",
  labelNames: ["method", "route", "status_code"],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

function normalizeIp(ip: string): { version: 4 | 6; normalized: string } {
  if (ip.startsWith("::ffff:")) {
    const ipv4 = ip.substring(7);
    if (isIpv4(ipv4)) {
      return { version: 4, normalized: ipv4 };
    }
  }
  if (isIpv4(ip)) {
    return { version: 4, normalized: ip };
  }
  return { version: 6, normalized: ip };
}

function isIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
  });
}

function matchIpv4(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  if (!range) return false;
  const bits = bitsStr ? parseInt(bitsStr, 10) : 32;
  if (!isIpv4(range) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);

  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");
  const p0 = parseInt(parts[0] || "0", 10);
  const p1 = parseInt(parts[1] || "0", 10);
  const p2 = parseInt(parts[2] || "0", 10);
  const p3 = parseInt(parts[3] || "0", 10);
  return ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;
}

function parseIpv6(ip: string): number[] | null {
  const parts = ip.split("::");
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];

  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;

  const middle = new Array(missing).fill("0");
  const hexParts = [...left, ...middle, ...right];

  if (hexParts.length !== 8) return null;

  const result: number[] = [];
  for (const part of hexParts) {
    if (part === "") {
      result.push(0);
    } else {
      const val = parseInt(part, 16);
      if (isNaN(val) || val < 0 || val > 0xffff) return null;
      result.push(val);
    }
  }
  return result;
}

function matchIpv6(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  if (!range) return false;
  const bits = bitsStr ? parseInt(bitsStr, 10) : 128;

  const ipParsed = parseIpv6(ip);
  const rangeParsed = parseIpv6(range);

  if (!ipParsed || !rangeParsed || bits < 0 || bits > 128) return false;

  let remainingBits = bits;
  for (let i = 0; i < 8; i++) {
    const ipVal = ipParsed[i] ?? 0;
    const rangeVal = rangeParsed[i] ?? 0;
    if (remainingBits >= 16) {
      if (ipVal !== rangeVal) return false;
      remainingBits -= 16;
    } else if (remainingBits > 0) {
      const mask = (~0 << (16 - remainingBits)) & 0xffff;
      if ((ipVal & mask) !== (rangeVal & mask)) return false;
      break;
    } else {
      break;
    }
  }
  return true;
}

function isIpAllowed(clientIp: string, allowedCidr?: string): boolean {
  const { version, normalized } = normalizeIp(clientIp.trim());

  if (version === 4 && normalized === "127.0.0.1") {
    return true;
  }
  if (version === 6 && (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1")) {
    return true;
  }

  if (!allowedCidr) {
    return false;
  }

  const cidrs = allowedCidr.split(",").map((c) => c.trim()).filter(Boolean);

  return cidrs.some((cidr) => {
    const [range] = cidr.split("/");
    if (!range) return false;
    const rangeNormal = normalizeIp(range);

    if (version !== rangeNormal.version) {
      return false;
    }

    if (version === 4) {
      return matchIpv4(normalized, cidr);
    } else {
      return matchIpv6(normalized, cidr);
    }
  });
}

function metricsIpGuard(req: Request, res: Response, next: NextFunction) {
  const clientIp = req.ip;
  if (!clientIp) {
    res.status(403).json({ error: "Access Denied: No client IP detected" });
    return;
  }

  if (isIpAllowed(clientIp, env.METRICS_ALLOWED_CIDR)) {
    next();
  } else {
    res.status(403).json({ error: "Access Denied: Client IP not allowed" });
  }
}

function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime();

  res.on("finish", () => {
    const diff = process.hrtime(start);
    const durationSeconds = diff[0] + diff[1] / 1e9;

    const route = req.route ? `${req.baseUrl}${(req as any).route.path}` : "not_found";
    const method = req.method;
    const statusCode = String(res.statusCode);

    httpRequestsTotal.inc({ method, route, status_code: statusCode });
    httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSeconds);
  });

  next();
}

app.use(httpMetricsMiddleware);

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

const ALLOWED_ORIGINS = (() => {
  const set = new Set<string>(["http://localhost:3000", "http://127.0.0.1:3000"]);
  for (const o of env.FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)) {
    set.add(o);
  }
  return set;
})();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: false,
  }),
);

app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many auth attempts; try again in 15 minutes" },
});

app.get("/health", async (_req, res) => {
  const checks = {
    db: "ok",
    soroban: "ok",
  };
  let hasError = false;

  try {
    await ping();
  } catch (err) {
    checks.db = "failed";
    hasError = true;
  }

  try {
    await pingRpc();
  } catch (err) {
    checks.soroban = "failed";
    hasError = true;
  }

  if (hasError) {
    res.status(503).json({
      status: "degraded",
      ...checks,
    });
  } else {
    res.json({
      status: "ok",
      ...checks,
      contractId: env.TARIFF_SHIELD_CONTRACT_ID,
      network: env.STELLAR_NETWORK,
      env: isProduction ? "production" : "development",
    });
  }
});

/**
 * Liveness probe: returns 200 OK unconditionally as long as the process is running.
 */
app.get("/health/live", (_req, res) => {
  res.status(200).send("OK");
});

/**
 * Readiness probe: checks all dependencies before clearing the service for traffic.
 */
app.get("/health/ready", async (_req, res) => {
  try {
    await Promise.all([ping(), pingRpc()]);
    res.status(200).send("OK");
  } catch (err) {
    res.status(503).send("Service Unavailable");
  }
});

client.collectDefaultMetrics();

app.get("/metrics", metricsIpGuard, async (_req, res) => {
  try {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.end(await client.register.metrics());
  } catch (err: any) {
    res.status(500).end(err?.message || "Internal Metrics Error");
  }
});

// ── OpenAPI spec + Swagger UI (issue #286) ────────────────────────────────

app.get("/docs/openapi.json", (_req, res) => {
  res.json(openApiSpec);
});

app.get("/docs", (_req, res) => {
  const specUrl = "/docs/openapi.json";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>TariffShield API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────

app.use("/auth/signup", authLimiter);
app.use("/auth/login", authLimiter);
app.use("/auth", authRouter);
app.use("/importers", importersRouter);
app.use("/importers", kycRouter);
app.use("/compliance", complianceRouter);
app.use("/admin", adminRouter);
app.use("/account", privacyRouter);
app.use("/privacy", privacyRouter);
app.use("/surety-license", suretyLicenseRouter);
app.use("/bonds", bondWebhookRouter);   // unauthenticated DocuSign webhook
app.use("/api", bondSignaturesRouter);  // authenticated bond signature routes

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[error]", err);
  res.status(500).json({ error: err.message || "internal error" });
});

async function start() {
  await migrate();
  await startIndexer();
  startReconciliationJob();
  await startOracleMonitor();
  startComplianceReportScheduler();
  app.listen(env.PORT, () => {
    console.log(`[boot] tariffshield API on :${env.PORT}`);
    console.log(`[boot] contract: ${env.TARIFF_SHIELD_CONTRACT_ID}`);
    console.log(`[boot] cors allowlist: ${Array.from(ALLOWED_ORIGINS).join(", ")}`);
  });
}

start().catch((err) => {
  console.error("[boot] fatal", err);
  process.exit(1);
});
