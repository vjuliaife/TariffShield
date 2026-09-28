# Notifications API

## Endpoints

### Mark Notification as Read

Marks a single notification as read. A regular user may only mark their
own notifications; a `surety_admin` may mark any notification (owner
check is skipped for that role).

- **URL:** `/notifications/:id/read`
- **Method:** `PATCH`
- **Authentication Required:** Yes (must re-accept privacy and TOS)

#### Path Parameters
- `id` (string): The ID of the notification to mark as read.

#### Request Body
None.

#### Response (200 OK)
```json
{
  "notification": {
    "id": "a1b2c3d4-...",
    "kind": "clawback",
    "message": "A clawback was initiated on bond BND-1042.",
    "readAt": "2026-09-25T09:15:00.000Z",
    "createdAt": "2026-09-24T18:02:11.000Z"
  }
}
```

#### Response (404 Not Found)
Returned both when no notification exists with the given `id`, and when
it exists but belongs to a different user (a regular user can't
distinguish the two cases from the response).
```json
{
  "error": "not found"
}
```

#### Idempotency

Marking an already-read notification as read again is a safe no-op: the
stored `read_at` timestamp is only ever set once, on the *first*
successful mark-read (`COALESCE(read_at, now())`). A repeat `PATCH` on
the same notification returns `200 OK` with the **original** `readAt`
value unchanged, not the time of the repeat call.

#### Example Request
```bash
curl -X PATCH https://api.example.com/notifications/a1b2c3d4-.../read \
  -H "Authorization: Bearer <token>"
```
