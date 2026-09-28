# Bond Signatures API

Electronic signing of customs bonds (CBP Form 301) through DocuSign (#317).
Implementation: [`apps/api/src/routes/bond-signatures.ts`](../../apps/api/src/routes/bond-signatures.ts).

The flow has three steps:

1. A surety admin creates a DocuSign envelope for a bond — `POST /api/bonds/:id/send-for-signature`.
2. Clients poll the envelope's progress — `GET /api/bonds/:id/signature-status`.
3. DocuSign Connect calls the webhook when the envelope is completed, declined
   or voided — `POST /bonds/docusign-webhook` (see [Webhook](#webhook-docusign-connect)).

Once the webhook records a `completed` envelope, `bond_records.signature_status`
becomes `completed`, which the API uses to gate deposits.

## Webhook: DocuSign Connect

Receives envelope status events from [DocuSign Connect](https://developers.docusign.com/platform/webhooks/connect/).
It is **not** authenticated with a TariffShield JWT or API key — trust comes
from the HMAC signature described below.

- **Method:** `POST`
- **Path:** `/bonds/docusign-webhook` (as configured in the DocuSign Connect
  listener URL, e.g. `https://api.tariffshield.io/bonds/docusign-webhook`) —
  see the mount-path note under [Known gaps](#known-gaps)
- **Content-Type:** `application/json` (configure the Connect listener for
  the JSON "SIM" event format)
- **Authentication:** HMAC-SHA256 signature header (see [Signature verification](#signature-verification))

### Payload fields

The handler reads only two values. Both the flat (legacy / custom) shape and
the DocuSign Connect JSON SIM shape are accepted; the flat field wins when
both are present.

| Field | Flat shape | Connect JSON SIM shape | Required | Notes |
|---|---|---|---|---|
| Envelope ID | `envelopeId` | `data.envelopeSummary.envelopeId` | Yes | Must match the `envelope_id` returned by `send-for-signature`. |
| Status | `status` | `data.envelopeSummary.status` | Yes | See status handling below. |

Everything else DocuSign sends (`event`, `generatedDateTime`, `data.accountId`,
`recipients`, document content, …) is accepted but ignored.

### Status handling

| `status` | Effect |
|---|---|
| `completed` | `bond_signatures.status → completed`, `completed_at = now()`, `signed_document_hash` = SHA-256 (hex) of the raw request body; the parent `bond_records.signature_status → completed`. |
| `declined` | `bond_signatures.status → declined`. The bond record is unchanged. |
| `voided` | `bond_signatures.status → voided`. The bond record is unchanged. |
| anything else (`sent`, `delivered`, …) | Acknowledged with `200`, no changes. |

An `envelopeId` that doesn't match any stored envelope is also acknowledged
with `200` and changes nothing, so DocuSign doesn't retry it.

### Responses

| Status | Body | When |
|---|---|---|
| `200 OK` | `{ "received": true }` | Event accepted (including ignored statuses and unknown envelopes). |
| `400 Bad Request` | `{ "error": "missing envelopeId or status" }` | Neither shape supplied an envelope ID and status. |
| `401 Unauthorized` | `{ "error": "invalid webhook signature" }` | Signature present but doesn't match (see below). |

DocuSign Connect treats any non-2xx response as a failure and retries.

### Signature verification

Enable **HMAC signatures** on the DocuSign Connect configuration and set the
same secret as `DOCUSIGN_WEBHOOK_HMAC_KEY` on the API
(see [environment variables](../environment-variables.md)).

DocuSign then sends:

```
X-DocuSign-Signature-1: <base64(HMAC-SHA256(DOCUSIGN_WEBHOOK_HMAC_KEY, raw request body))>
```

The API recomputes the HMAC over the **exact raw request bytes** and compares
it in constant time. Anything that re-serialises the JSON (a proxy, a body
re-encoder) will break verification.

Integrators sending test events by hand can produce the header with:

```bash
BODY='{"envelopeId":"STUB-ENV-42-1727200000000","status":"completed"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$DOCUSIGN_WEBHOOK_HMAC_KEY" -binary | base64)
curl -X POST "$API_URL/bonds/docusign-webhook" \
  -H 'Content-Type: application/json' \
  -H "X-DocuSign-Signature-1: $SIG" \
  --data "$BODY"
```

> **Security:** anyone who holds `DOCUSIGN_WEBHOOK_HMAC_KEY` can forge
> signing-completion events and unlock deposits for a bond. Treat it like
> any other secret (see [`security-model.md`](../security-model.md)).

### Example payloads

DocuSign Connect JSON (SIM) — `envelope-completed`:

```json
{
  "event": "envelope-completed",
  "apiVersion": "v2.1",
  "uri": "/restapi/v2.1/accounts/1a2b3c4d-0000-0000-0000-000000000000/envelopes/93be49e8-6f2a-4d1b-9c6e-2f0d3f8a1b77",
  "retryCount": 0,
  "configurationId": 10501234,
  "generatedDateTime": "2026-09-24T14:05:12.3100000Z",
  "data": {
    "accountId": "1a2b3c4d-0000-0000-0000-000000000000",
    "userId": "5e6f7a8b-0000-0000-0000-000000000000",
    "envelopeId": "93be49e8-6f2a-4d1b-9c6e-2f0d3f8a1b77",
    "envelopeSummary": {
      "envelopeId": "93be49e8-6f2a-4d1b-9c6e-2f0d3f8a1b77",
      "status": "completed",
      "emailSubject": "Please sign: CBP Form 301 continuous bond",
      "sentDateTime": "2026-09-24T13:40:02.0000000Z",
      "completedDateTime": "2026-09-24T14:05:10.0000000Z"
    }
  }
}
```

Minimal flat payload (useful for local testing against the dev stub):

```json
{
  "envelopeId": "STUB-ENV-42-1727200000000",
  "status": "completed"
}
```

Response:

```json
{ "received": true }
```

### Known gaps

The behaviour above is what the webhook is designed to do. Integrators
should be aware that the current implementation differs in a few ways:

- **Signature check is effectively skipped today.** Verification only runs
  when `DOCUSIGN_WEBHOOK_HMAC_KEY` is set, the `X-DocuSign-Signature-1` header
  is present, **and** the raw request body is available as `req.rawBody`.
  Nothing in `apps/api/src/index.ts` currently captures `rawBody` (the global
  `express.json()` has no `verify` hook), so requests are accepted without
  verification, and `signed_document_hash` is stored as `null`. A request
  that simply omits the header is also accepted even when the key is set.
- **Signature length mismatch.** A header whose length differs from the
  expected base64 digest makes `crypto.timingSafeEqual` throw, so the
  request fails with a `5xx` instead of `401`.
- **Mount path.** `bondWebhookRouter` is mounted at `/bonds` and declares
  the route as `/bonds/docusign-webhook`, so the handler is currently served
  at `/bonds/bonds/docusign-webhook`. Check the deployed path before
  configuring the Connect listener URL.
