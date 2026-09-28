# Importers API Documentation

## Overview

The Importers API provides endpoints for managing importer entities, their compliance documents, activity events, and operational data.

## Base URL

All endpoints are prefixed with `/api/v1/importers`

## Authentication

All endpoints require Bearer token authentication via the `Authorization` header:

```
Authorization: Bearer <your-jwt-token>
```

---

## Documents Management

### POST /importers/:id/documents

Upload compliance documents for an importer (e.g., licenses, certifications, Form 301).

**Authorization**: Importer owner or surety admin

**Request Format**: `multipart/form-data`

**Parameters**:
- `id` (path, required): Importer ID

**Request Body**:
- `document` (file, required): The document file to upload
- `documentType` (string, required): Document classification
  - Allowed values: `license`, `form_301`, `certification`, `compliance`, `other`
- `description` (string, optional): Human-readable document description
- `expiresAt` (ISO 8601 date, optional): Document expiration date

**Accepted File Types**:
- PDF (`.pdf`)
- Images: JPEG (`.jpg`, `.jpeg`), PNG (`.png`)
- Documents: DOCX (`.docx`), DOC (`.doc`)

**File Size Limits**:
- Maximum file size: 10 MB
- Files are automatically scanned for viruses before storage

**Example Request**:
```bash
curl -X POST https://api.tariffshield.com/api/v1/importers/abc123/documents \
  -H "Authorization: Bearer <token>" \
  -F "document=@license.pdf" \
  -F "documentType=license" \
  -F "description=Import License 2024" \
  -F "expiresAt=2024-12-31T23:59:59Z"
```

**Response** (201 Created):
```json
{
  "document": {
    "id": "doc_xyz789",
    "importerId": "abc123",
    "documentType": "license",
    "description": "Import License 2024",
    "filename": "license.pdf",
    "fileSize": 245760,
    "contentType": "application/pdf",
    "uploadedBy": "user_123",
    "uploadedAt": "2024-01-15T10:30:00Z",
    "expiresAt": "2024-12-31T23:59:59Z",
    "scanStatus": "clean",
    "s3Key": "encrypted-key"
  }
}
```

**Error Responses**:
- `400 Bad Request`: Invalid file type or missing required fields
- `403 Forbidden`: User not authorized to upload documents for this importer
- `413 Payload Too Large`: File exceeds 10 MB limit
- `422 Unprocessable Entity`: Virus detected in uploaded file

---

### GET /importers/:id/documents

List all documents for an importer with pagination support.

**Authorization**: Importer owner or surety admin

**Parameters**:
- `id` (path, required): Importer ID
- `limit` (query, optional): Number of documents per page (default: 20, max: 100)
- `offset` (query, optional): Number of documents to skip (default: 0)
- `documentType` (query, optional): Filter by document type
- `includeExpired` (query, optional): Include expired documents (default: false)

**Example Request**:
```bash
curl -X GET "https://api.tariffshield.com/api/v1/importers/abc123/documents?limit=10&documentType=license" \
  -H "Authorization: Bearer <token>"
```

**Response** (200 OK):
```json
{
  "documents": [
    {
      "id": "doc_xyz789",
      "importerId": "abc123",
      "documentType": "license",
      "description": "Import License 2024",
      "filename": "license.pdf",
      "fileSize": 245760,
      "contentType": "application/pdf",
      "uploadedBy": "user_123",
      "uploadedAt": "2024-01-15T10:30:00Z",
      "expiresAt": "2024-12-31T23:59:59Z",
      "scanStatus": "clean",
      "downloadUrl": "https://api.tariffshield.com/api/v1/importers/abc123/documents/doc_xyz789/download"
    }
  ],
  "pagination": {
    "total": 45,
    "limit": 10,
    "offset": 0,
    "hasMore": true
  }
}
```

**Error Responses**:
- `403 Forbidden`: User not authorized to view documents for this importer
- `404 Not Found`: Importer not found

---

### DELETE /importers/:id/documents/:docId

Delete an importer document.

**Authorization**: Importer owner or surety admin

**Deletion Behavior**: **Soft delete** — Documents are marked as deleted but retained for audit compliance. Physical deletion occurs after the regulatory retention period (7 years).

**Parameters**:
- `id` (path, required): Importer ID
- `docId` (path, required): Document ID

**Example Request**:
```bash
curl -X DELETE https://api.tariffshield.com/api/v1/importers/abc123/documents/doc_xyz789 \
  -H "Authorization: Bearer <token>"
```

**Response** (200 OK):
```json
{
  "deleted": true,
  "documentId": "doc_xyz789",
  "deletedAt": "2024-01-15T11:45:00Z",
  "deletedBy": "user_123",
  "retentionUntil": "2031-01-15T11:45:00Z"
}
```

**Error Responses**:
- `403 Forbidden`: User not authorized to delete documents for this importer
- `404 Not Found`: Document not found or already deleted
- `409 Conflict`: Document is referenced by active compliance review and cannot be deleted

**Notes**:
- Deleted documents are excluded from GET /documents responses unless `includeDeleted=true` is specified (admin only)
- Download URLs for deleted documents return 410 Gone
- Audit logs retain references to deleted documents

---

## Activity Events

### GET /importers/:id/events

Retrieve the activity/audit timeline for an importer.

**Authorization**: Importer owner or surety admin

**Parameters**:
- `id` (path, required): Importer ID
- `limit` (query, optional): Events per page (default: 50, max: 200)
- `offset` (query, optional): Events to skip (default: 0)
- `eventType` (query, optional): Filter by event type
- `startDate` (query, optional): Filter events after this date (ISO 8601)
- `endDate` (query, optional): Filter events before this date (ISO 8601)

**Event Types**:
- `importer_created`: Importer entity registered
- `document_uploaded`: Compliance document uploaded
- `document_deleted`: Document removed
- `collateral_deposited`: Funds deposited to collateral account
- `collateral_withdrawn`: Funds withdrawn from collateral
- `bond_created`: Customs bond issued
- `bond_updated`: Bond details modified
- `review_started`: Compliance review initiated
- `review_approved`: Review approved
- `review_rejected`: Review rejected
- `credit_line_granted`: Credit line extended
- `credit_line_revoked`: Credit line terminated
- `tariff_uploaded`: Tariff schedule uploaded
- `alert_triggered`: Tariff spike alert fired
- `webhook_configured`: Webhook endpoint added
- `api_key_created`: API key generated
- `api_key_revoked`: API key disabled

**Example Request**:
```bash
curl -X GET "https://api.tariffshield.com/api/v1/importers/abc123/events?limit=20&eventType=document_uploaded&startDate=2024-01-01T00:00:00Z" \
  -H "Authorization: Bearer <token>"
```

**Response** (200 OK):
```json
{
  "events": [
    {
      "id": "evt_123",
      "importerId": "abc123",
      "eventType": "document_uploaded",
      "timestamp": "2024-01-15T10:30:00Z",
      "actorId": "user_123",
      "actorEmail": "importer@example.com",
      "actorRole": "importer",
      "metadata": {
        "documentId": "doc_xyz789",
        "documentType": "license",
        "filename": "license.pdf",
        "fileSize": 245760
      },
      "ipAddress": "203.0.113.42"
    },
    {
      "id": "evt_124",
      "importerId": "abc123",
      "eventType": "collateral_deposited",
      "timestamp": "2024-01-15T11:00:00Z",
      "actorId": "user_123",
      "actorEmail": "importer@example.com",
      "actorRole": "importer",
      "metadata": {
        "amount": "50000.00",
        "currency": "USD",
        "txHash": "abc...def",
        "stellarAddress": "GABC...XYZ"
      },
      "ipAddress": "203.0.113.42"
    }
  ],
  "pagination": {
    "total": 342,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

**Error Responses**:
- `403 Forbidden`: User not authorized to view events for this importer
- `404 Not Found`: Importer not found

**Notes**:
- Events are immutable and retained permanently for regulatory audit
- Sensitive data (e.g., API keys, passwords) is never included in event metadata
- Events are returned in reverse chronological order (newest first)

---

## See Also

- [Authentication Guide](./authentication.md)
- [Error Codes Reference](./error-codes.md)
- [Rate Limits](./rate-limits.md)
- [Webhooks](../guides/webhooks.md)
