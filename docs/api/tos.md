# Terms of Service (ToS) API Documentation

## Overview

The ToS API manages Terms of Service acceptance tracking and version history for TariffShield platform users.

## Base URL

All endpoints are prefixed with `/api/v1/account`

## Authentication

All endpoints require Bearer token authentication:

```
Authorization: Bearer <your-jwt-token>
```

---

## ToS Versioning System

TariffShield maintains a versioned Terms of Service system to ensure compliance with legal requirements and provide users with transparency about policy changes.

**Version Format**: `YYYY-MM-DD-v#` (e.g., `2024-01-15-v1`)

**Versioning Behavior**:
- Each ToS document has a unique `versionId`
- Users must explicitly accept new versions when material changes occur
- Acceptance history is immutable and retained for audit compliance
- Users can view all previously accepted versions

**Reacceptance Triggers**:
- Material changes to user rights, obligations, or liability
- Changes to data handling, privacy policies, or dispute resolution
- Regulatory updates requiring explicit user consent

When reacceptance is required, API requests return `403 Forbidden` with error code `TOS_REACCEPTANCE_REQUIRED` until the user accepts the latest version.

---

## GET /account/tos-history

Retrieve the authenticated user's complete ToS acceptance history.

**Authorization**: Authenticated user (any role)

**Parameters**: None

**Example Request**:
```bash
curl -X GET https://api.tariffshield.com/api/v1/account/tos-history \
  -H "Authorization: Bearer <token>"
```

**Response** (200 OK):
```json
{
  "acceptances": [
    {
      "tos_version": "2024-01-15-v1",
      "accepted_at": "2024-01-15T14:30:00Z",
      "acceptance_method": "signup",
      "ip_address": "203.0.113.42",
      "effective_date": "2024-01-15",
      "change_summary": "Initial Terms of Service for platform launch"
    },
    {
      "tos_version": "2023-11-01-v1",
      "accepted_at": "2023-11-05T09:15:00Z",
      "acceptance_method": "re-acceptance",
      "ip_address": "203.0.113.42",
      "effective_date": "2023-11-01",
      "change_summary": "Updated dispute resolution clause to include arbitration agreement"
    },
    {
      "tos_version": "2023-08-01-v1",
      "accepted_at": "2023-08-10T11:00:00Z",
      "acceptance_method": "signup",
      "ip_address": "198.51.100.25",
      "effective_date": "2023-08-01",
      "change_summary": "Beta launch terms"
    }
  ]
}
```

**Response Fields**:
- `tos_version` (string): Unique version identifier
- `accepted_at` (ISO 8601): Timestamp when user accepted this version
- `acceptance_method` (string): How acceptance was recorded
  - `signup`: Accepted during account creation
  - `re-acceptance`: Accepted after mandatory update
  - `admin_migration`: Migrated from legacy system
- `ip_address` (string | null): IP address from which acceptance originated
- `effective_date` (ISO 8601 date): Date when this ToS version took effect
- `change_summary` (string): Human-readable summary of what changed in this version

**Notes**:
- Acceptances are returned in reverse chronological order (newest first)
- IP addresses may be `null` for legacy records or privacy-protected sessions
- All acceptances are immutable; corrections require contacting support

---

## POST /account/accept-tos

Accept a new ToS version (typically used for mandatory reacceptance).

**Authorization**: Authenticated user (any role)

**Request Body** (JSON):
```json
{
  "versionId": "2024-01-15-v1"
}
```

**Request Fields**:
- `versionId` (string, required): The version identifier to accept (must be a valid, published ToS version)

**Example Request**:
```bash
curl -X POST https://api.tariffshield.com/api/v1/account/accept-tos \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"versionId": "2024-01-15-v1"}'
```

**Response** (200 OK):
```json
{
  "accepted": true,
  "versionId": "2024-01-15-v1",
  "acceptedAt": "2024-01-15T14:30:00Z",
  "metadata": {
    "ip_address": "203.0.113.42",
    "user_agent": "Mozilla/5.0...",
    "acceptance_method": "re-acceptance"
  }
}
```

**Response Fields**:
- `accepted` (boolean): Always `true` on success
- `versionId` (string): The version that was accepted
- `acceptedAt` (ISO 8601): Timestamp of acceptance
- `metadata` (object): Audit trail metadata
  - `ip_address` (string): Request origin IP
  - `user_agent` (string): HTTP User-Agent header
  - `acceptance_method` (string): Fixed value `"re-acceptance"`

**Error Responses**:
- `400 Bad Request`: Missing or invalid `versionId`
  ```json
  {
    "error": "versionId is required",
    "code": "MISSING_VERSION_ID"
  }
  ```
- `404 Not Found`: Version does not exist or is not published
  ```json
  {
    "error": "ToS version not found",
    "code": "TOS_VERSION_NOT_FOUND",
    "versionId": "2024-99-99-v1"
  }
  ```
- `409 Conflict`: Version already accepted by this user
  ```json
  {
    "error": "ToS version already accepted",
    "code": "TOS_ALREADY_ACCEPTED",
    "acceptedAt": "2024-01-15T10:00:00Z"
  }
  ```

**Idempotency**:
- Accepting the same version multiple times is rejected with `409 Conflict`
- Use GET /tos-history to check if a version has been accepted before calling this endpoint

**Side Effects**:
- Clears the `tos_reacceptance_required` flag on the user's account
- Subsequent API requests will no longer return `TOS_REACCEPTANCE_REQUIRED` errors
- An audit log entry is created (visible in the user's activity timeline)

---

## Checking Current ToS Status

To determine if a user needs to accept a new ToS version, inspect the `tos_reacceptance_required` flag in the user's profile:

```bash
curl -X GET https://api.tariffshield.com/api/v1/account/profile \
  -H "Authorization: Bearer <token>"
```

**Response excerpt**:
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "tos_reacceptance_required": true,
    "required_tos_version": "2024-01-15-v1"
  }
}
```

If `tos_reacceptance_required` is `true`, the user must call POST /accept-tos before performing write operations on the platform.

---

## Retrieving ToS Document Content

**Note**: Fetching the actual ToS document text (HTML, Markdown, or PDF) is handled by a separate public endpoint:

```
GET /public/tos/:versionId
```

This endpoint does **not** require authentication and returns the full legal text for display in client applications.

---

## Integration Examples

### React Component Example

```typescript
import { useState, useEffect } from 'react';

export function TosReacceptanceModal({ user, apiClient }) {
  const [accepting, setAccepting] = useState(false);
  
  const handleAccept = async () => {
    setAccepting(true);
    try {
      await apiClient.post('/account/accept-tos', {
        versionId: user.required_tos_version
      });
      window.location.reload(); // Refresh to clear TOS_REACCEPTANCE_REQUIRED
    } catch (error) {
      console.error('Failed to accept ToS:', error);
    } finally {
      setAccepting(false);
    }
  };
  
  if (!user.tos_reacceptance_required) return null;
  
  return (
    <Modal>
      <h2>Terms of Service Update</h2>
      <p>We've updated our Terms of Service. Please review and accept to continue.</p>
      <iframe src={`/public/tos/${user.required_tos_version}`} />
      <button onClick={handleAccept} disabled={accepting}>
        {accepting ? 'Accepting...' : 'I Accept'}
      </button>
    </Modal>
  );
}
```

---

## See Also

- [Authentication Guide](./authentication.md)
- [Error Codes Reference](./error-codes.md)
- [Privacy Policy Endpoints](./privacy.md) (similar acceptance flow for privacy policies)
