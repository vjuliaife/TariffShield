import debug from "debug";
import { rpc } from "@stellar/stellar-sdk";

const log = debug("tariffshield:soroban");

const isTest = process.env.NODE_ENV === "test";
const forceDebug = process.env.FORCE_SOROBAN_DEBUG === "true";
const isAllowedEnv = !isTest || forceDebug;

const hasDebugSorobanEnv = typeof process.env.DEBUG === "string" && (
  process.env.DEBUG.split(",").some((val) => {
    const trimmed = val.trim();
    return trimmed === "soroban:*" || trimmed === "tariffshield:soroban" || trimmed === "*";
  })
);

const hasLogLevelSorobanDebug = process.env.LOG_LEVEL === "debug" && process.env.SOROBAN_DEBUG === "true";
const hasSorobanDebugOnly = process.env.SOROBAN_DEBUG === "true";

const isEnabled = isAllowedEnv && (hasDebugSorobanEnv || hasLogLevelSorobanDebug || hasSorobanDebugOnly);

if (isEnabled) {
  const current = process.env.DEBUG || "";
  const namespaces = current.split(",").map((s) => s.trim()).filter(Boolean);
  if (!namespaces.includes("tariffshield:soroban") && !namespaces.includes("*")) {
    namespaces.push("tariffshield:soroban");
    debug.enable(namespaces.join(","));
  }
}

interface SorobanRpcLogPayload {
  httpMethod: string;
  rpcMethod: string;
  requestParams: any;
  responseStatus: number;
  responseBody: any;
  elapsedTimeMs: number;
}

function redact(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === "string") {
    if (/^S[A-D2-7][A-Z2-7]{54}$/.test(obj)) {
      return "[REDACTED]";
    }
    if (obj.length > 100 && /^[A-Za-z0-9+/=]+$/.test(obj)) {
      return "[REDACTED]";
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(redact);
  }
  if (typeof obj === "object") {
    const cleaned: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "secretkey" || lowerKey === "source") {
        cleaned[key] = "[REDACTED]";
      } else {
        cleaned[key] = redact(obj[key]);
      }
    }
    return cleaned;
  }
  return obj;
}

function getRequestJsonData(config: any): any {
  if (!config?.data) return null;
  if (typeof config.data === "string") {
    try {
      return JSON.parse(config.data);
    } catch {
      return config.data;
    }
  }
  return config.data;
}

const isPretty = process.env.SOROBAN_LOG_PRETTY === "true";

function writeLog(payload: SorobanRpcLogPayload): void {
  const redacted = redact(payload);
  const logString = isPretty ? JSON.stringify(redacted, null, 2) : JSON.stringify(redacted);
  log(logString);
}

export function registerSorobanLogger(server: rpc.Server): void {
  if (!isEnabled) {
    return;
  }

  server.httpClient.interceptors.request.use((config) => {
    (config as any).startTime = Date.now();
    return config;
  });

  server.httpClient.interceptors.response.use(
    (response) => {
      const startTime = (response.config as any)?.startTime;
      const elapsedTimeMs = startTime ? Date.now() - startTime : 0;

      const requestData = getRequestJsonData(response.config);

      const payload: SorobanRpcLogPayload = {
        httpMethod: response.config.method?.toUpperCase() || "POST",
        rpcMethod: requestData?.method || "unknown",
        requestParams: requestData?.params || null,
        responseStatus: response.status,
        responseBody: response.data,
        elapsedTimeMs,
      };

      writeLog(payload);
      return response;
    },
    (error) => {
      const startTime = (error.config as any)?.startTime;
      const elapsedTimeMs = startTime ? Date.now() - startTime : 0;

      const requestData = getRequestJsonData(error.config);
      const responseStatus = error.response?.status || 500;
      const responseBody = error.response?.data || error.message;

      const payload: SorobanRpcLogPayload = {
        httpMethod: error.config?.method?.toUpperCase() || "POST",
        rpcMethod: requestData?.method || "unknown",
        requestParams: requestData?.params || null,
        responseStatus,
        responseBody,
        elapsedTimeMs,
      };

      writeLog(payload);
      throw error;
    }
  );
}
