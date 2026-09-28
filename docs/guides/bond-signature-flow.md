# Bond Signature Flow

TariffShield uses DocuSign to collect legally-binding e-signatures on surety bonds. This guide explains what happens at each step — from the surety admin sending the envelope to you completing the signature — and how to check status at any point.

---

## Overview

```
Surety admin                  DocuSign                        Importer
     │                            │                               │
     │── POST /bonds/:id/         │                               │
     │   send-for-signature ──────┤                               │
     │                            │── Email with signing link ───►│
     │                            │                               │── Signs in
     │                            │                               │   DocuSign UI
     │◄── webhook: completed ─────│◄──────────────────────────────│
     │    (bond marked signed)    │                               │
```

---

## Step 1: Receive the signing email

Once the surety admin initiates the process, DocuSign sends you an email containing a unique signing link. The link is valid for the duration of the envelope's expiry window (set by the surety). Clicking it opens the DocuSign signing interface directly — no TariffShield login is required to sign.

---

## Step 2: Complete the signature

Inside the DocuSign UI:

1. Review the bond document in full.
2. Click each required signature or initials field.
3. Click **Finish** to submit your signature.

DocuSign will show a confirmation screen and send a completion email with a copy of the signed document.

---

## Step 3: Check signature status

You can check the status of your bond signature at any time using:

```
GET /api/v1/bonds/:bondId/signature-status
Authorization: Bearer <your-token>
```

**Response:**

```json
{
  "bondId": "b3f2a1c0-...",
  "signatureStatus": "sent",
  "envelope": {
    "id": "env-...",
    "envelopeId": "abc123...",
    "signingUrl": "https://demo.docusign.net/signing?envelope=abc123...",
    "status": "sent",
    "signedDocumentHash": null,
    "completedAt": null,
    "lastReminderSentAt": null,
    "createdAt": "2026-09-25T04:22:00.000Z"
  }
}
```

### Status values

| `signatureStatus` (bond record) | `envelope.status` | Meaning |
|---|---|---|
| `sent` | `sent` | Envelope created; awaiting your signature |
| `completed` | `completed` | Signature received; bond is fully executed |
| `voided` | `voided` | Envelope was cancelled by the surety admin |

The `envelope.signingUrl` field in the response lets you re-open the DocuSign signing page if you closed it before finishing.

---

## Step 4: What happens on completion

When DocuSign delivers the `completed` webhook event to TariffShield:

- Your bond record is updated: `signature_status → completed`.
- A SHA-256 hash of the signed envelope payload is stored as `signedDocumentHash` for audit purposes.
- The surety admin is notified and can proceed with bond activation.

If the envelope expires before you sign, the surety admin must void the existing envelope and send a new one. You will receive a new signing email automatically.

---

## Frequently asked questions

**Can I sign on mobile?**
Yes. The DocuSign signing link works in any modern browser, including mobile.

**What if I don't receive the email?**
Check your spam folder for mail from DocuSign (`dse@docusign.net`). If it is not there, ask your surety admin to resend. You can also retrieve the signing URL directly from `GET /bonds/:id/signature-status` → `envelope.signingUrl`.

**Can I delegate signing to someone else?**
Not through TariffShield — the signing link is sent to the importer's registered email address. If you need a different signatory, contact your surety admin to update the bond record before a new envelope is sent.

**How long do I have to sign?**
The expiry window is set when the surety admin creates the envelope. Contact your surety admin for the exact deadline; it will also be shown in the DocuSign signing interface.

---

## Related docs

- [API Authentication](../api/authentication.md)
- [SDK Tutorial — Importer Lifecycle](../sdk-tutorial.md)
