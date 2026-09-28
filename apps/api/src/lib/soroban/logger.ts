/**
 * Soroban RPC trace logging (#972).
 *
 * There is a single logging stack in the API: pino (see ../logger.ts). RPC
 * traces are emitted through a child of that logger rather than a separate
 * `debug`-package logger, so they share its output format (pino-pretty in
 * development, JSON in production), transport and correlation-friendly
 * structure. Every trace line carries `component: 'soroban-rpc'` so it can be
 * filtered out of the combined stream.
 *
 * The traces are opt-in and independent of LOG_LEVEL: they are enabled by
 * `SOROBAN_DEBUG=true` or a `DEBUG` value of `soroban:*`, `tariffshield:soroban`
 * or `*` (the toggles the previous `debug`-based logger honoured), and are
 * always off under NODE_ENV=test unless `FORCE_SOROBAN_DEBUG=true`. When
 * enabled, the child logger is pinned to `debug` so the traces show up even
 * though the app logger defaults to `info`.
 *
 * Request params and response bodies are passed through `redact()` before
 * they reach the logger, so secret keys and signed XDR blobs never leave
 * the process.
 */
import { rpc } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';

const SOROBAN_DEBUG_NAMESPACES = ['soroban:*', 'tariffshield:soroban', '*'];

export function isSorobanRpcLoggingEnabled(envVars: NodeJS.ProcessEnv = process.env): boolean {
  const isTest = envVars.NODE_ENV === 'test';
  const forceDebug = envVars.FORCE_SOROBAN_DEBUG === 'true';
  if (isTest && !forceDebug) {
    return false;
  }

  const hasDebugSorobanEnv =
    typeof envVars.DEBUG === 'string' &&
    envVars.DEBUG.split(',').some((val) => SOROBAN_DEBUG_NAMESPACES.includes(val.trim()));

  return hasDebugSorobanEnv || envVars.SOROBAN_DEBUG === 'true';
}

const isEnabled = isSorobanRpcLoggingEnabled();

const sorobanLogger = logger.child({ component: 'soroban-rpc' }, { level: 'debug' });

interface SorobanRpcLogPayload {
  httpMethod: string;
  rpcMethod: string;
  requestParams: any;
  responseStatus: number;
  responseBody: any;
  elapsedTimeMs: number;
}

export function redact(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj === 'string') {
    if (/^S[A-D2-7][A-Z2-7]{54}$/.test(obj)) {
      return '[REDACTED]';
    }
    if (obj.length > 100 && /^[A-Za-z0-9+/=]+$/.test(obj)) {
      return '[REDACTED]';
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(redact);
  }
  if (typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'secretkey' || lowerKey === 'source') {
        cleaned[key] = '[REDACTED]';
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
  if (typeof config.data === 'string') {
    try {
      return JSON.parse(config.data);
    } catch {
      return config.data;
    }
  }
  return config.data;
}

function writeLog(payload: SorobanRpcLogPayload): void {
  sorobanLogger.debug({ rpc: redact(payload) }, `soroban rpc ${payload.rpcMethod}`);
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
        httpMethod: response.config.method?.toUpperCase() || 'POST',
        rpcMethod: requestData?.method || 'unknown',
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
        httpMethod: error.config?.method?.toUpperCase() || 'POST',
        rpcMethod: requestData?.method || 'unknown',
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
