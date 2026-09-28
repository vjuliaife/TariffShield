# Account Erasure API

The Account Erasure API allows authenticated end-users to request GDPR-style data erasure and check the status of their requests.

## Endpoints

### 1. Request Data Erasure

Allows a user to initiate a data erasure request.

- **URL:** `/account/erasure-request`
- **Method:** `POST`
- **Authentication Required:** Yes (must re-accept privacy and TOS)

#### Request Body
```json
{
  "reason": "Optional reason for account deletion"
}
```

#### Response (202 Accepted)
```json
{
  "requestId": "uuid",
  "status": "pending",
  "requestedAt": "2023-10-25T12:00:00Z",
  "slaDealineAt": "2023-11-25T12:00:00Z"
}
```

### 2. Get Erasure Request Status

Fetches the current status of an existing data erasure request.

- **URL:** `/account/erasure-request/:requestId`
- **Method:** `GET`
- **Authentication Required:** Yes

#### Path Parameters
- `requestId` (string): The ID of the erasure request returned from the POST endpoint.

#### Response (200 OK)
```json
{
  "requestId": "uuid",
  "status": "pending",
  "requestedAt": "2023-10-25T12:00:00Z",
  "slaDealineAt": "2023-11-25T12:00:00Z",
  "affectedFields": ["name", "email", "documents"],
  "errorMessage": null
}
```

## Erasure Request Status Values

The `status` field in the response can have the following values:
- `pending`: The erasure request has been received and is waiting to be processed.
- `in_progress`: The erasure request is actively being processed across systems.
- `completed`: The user's data has been successfully erased.
- `failed`: The erasure request encountered an error. Check `errorMessage` for details.
