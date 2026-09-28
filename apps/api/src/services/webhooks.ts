import { createHmac, randomBytes } from 'crypto';
import pino from 'pino';
import { pool } from '../db.js';

const logger = pino({ name: 'webhooks' });

export type WebhookEventType = 'deposit' | 'top_up' | 'clawback';

export const ALLOWED_WEBHOOK_EVENT_TYPES: WebhookEventType[] = ['deposit', 'top_up', 'clawback'];

export interface WebhookSubscriptionRow {
  id: string;
  importer_id: string;
  target_url: string;
  secret: string;
  event_types: string[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  subscription_id: string;
  importer_id: string;
  event_type: string;
  payload: any;
  attempt_number: number;
  status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  delivered_at: Date | null;
  next_retry_at: Date | null;
  status: 'success' | 'failed' | 'pending_retry';
  created_at: Date;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export function signWebhookPayload(payload: string, timestampSeconds: number, secret: string): string {
  const signaturePayload = `${timestampSeconds}.${payload}`;
  const hmac = createHmac('sha256', secret).update(signaturePayload).digest('hex');
  return `t=${timestampSeconds},v1=${hmac}`;
}

const BACKOFF_DELAYS_MS = [0, 15_000, 60_000, 300_000, 900_000]; // 0s, 15s, 1m, 5m, 15m
const HTTP_TIMEOUT_MS = 5_000;

export async function dispatchWebhookEvent(
  importerId: string,
  eventType: WebhookEventType,
  payloadData: Record<string, unknown>
): Promise<void> {
  try {
    const subsRes = await pool.query<WebhookSubscriptionRow>(
      `SELECT id, importer_id, target_url, secret, event_types, is_active, created_at, updated_at
       FROM webhook_subscriptions
       WHERE importer_id = $1 AND is_active = TRUE AND $2 = ANY(event_types)`,
      [importerId, eventType]
    );

    if (!subsRes.rowCount || subsRes.rowCount === 0) {
      return;
    }

    for (const sub of subsRes.rows) {
      executeWebhookDelivery(sub, eventType, payloadData, 1).catch((err) => {
        logger.error({ err, subscriptionId: sub.id, eventType }, 'Unhandled error during webhook delivery execution');
      });
    }
  } catch (err) {
    logger.error({ err, importerId, eventType }, 'Failed to query webhook subscriptions for dispatch');
  }
}

export async function executeWebhookDelivery(
  sub: WebhookSubscriptionRow,
  eventType: string,
  payloadData: Record<string, unknown>,
  attemptNumber: number
): Promise<WebhookDeliveryRow> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadJson = JSON.stringify({
    id: randomBytes(16).toString('hex'),
    event: eventType,
    createdAt: new Date().toISOString(),
    data: payloadData,
  });

  const signature = signWebhookPayload(payloadJson, timestamp, sub.secret);
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let isSuccess = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const res = await fetch(sub.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TariffShield-Event': eventType,
        'X-TariffShield-Timestamp': String(timestamp),
        'X-TariffShield-Signature': signature,
        'User-Agent': 'TariffShield-Webhook-Dispatcher/1.0',
      },
      body: payloadJson,
      signal: controller.signal,
    });

    statusCode = res.status;
    const bodyText = await res.text().catch(() => '');
    responseBody = bodyText.slice(0, 1000);

    if (res.ok) {
      isSuccess = true;
    } else {
      errorMessage = `HTTP status ${res.status}`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      errorMessage = `Request timed out after ${HTTP_TIMEOUT_MS}ms`;
    } else {
      errorMessage = err.message || 'Network error';
    }
  } finally {
    clearTimeout(timeout);
  }

  const nextDelayMs = BACKOFF_DELAYS_MS[attemptNumber];
  const canRetry = !isSuccess && attemptNumber < BACKOFF_DELAYS_MS.length - 1;
  const status: 'success' | 'failed' | 'pending_retry' = isSuccess
    ? 'success'
    : canRetry
    ? 'pending_retry'
    : 'failed';

  const deliveredAt = isSuccess ? new Date() : null;
  const nextRetryAt = canRetry ? new Date(Date.now() + nextDelayMs!) : null;

  const insertRes = await pool.query<WebhookDeliveryRow>(
    `INSERT INTO webhook_deliveries (
       subscription_id, importer_id, event_type, payload, attempt_number,
       status_code, response_body, error_message, delivered_at, next_retry_at, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      sub.id,
      sub.importer_id,
      eventType,
      payloadJson,
      attemptNumber,
      statusCode,
      responseBody,
      errorMessage,
      deliveredAt,
      nextRetryAt,
      status,
    ]
  );

  const deliveryRow = insertRes.rows[0]!;

  if (canRetry && nextDelayMs) {
    setTimeout(() => {
      executeWebhookDelivery(sub, eventType, payloadData, attemptNumber + 1).catch((err) => {
        logger.error({ err, subscriptionId: sub.id, attemptNumber: attemptNumber + 1 }, 'Failed retry attempt');
      });
    }, nextDelayMs);
  }

  return deliveryRow;
}
