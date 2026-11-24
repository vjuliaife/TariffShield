# API Rate Limits

TariffShield applies two layers of rate limiting to protect the API from abuse and credential-stuffing attacks. Limits vary by endpoint group; the table below lists every affected route.

---

## Limits by endpoint group

| Endpoint group | Routes | Window | Max requests | Who is limited |
|---|---|---|---|---|
| **Auth (unauthenticated)** | `POST /auth/login`, `POST /auth/signup`, `POST /auth/refresh` | 15 minutes | 20 | Per IP |
| **Authenticated session** | `POST /auth/logout`, `GET /auth/me` | 1 minute | 60 | Per IP |

All other routes are not currently rate limited at the application layer. Infrastructure-level limits (load balancer, CDN) may still apply.

---

## Response when a limit is exceeded

When the limit is reached the API responds with HTTP **429 Too Many Requests**:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 20
RateLimit-Remaining: 0
RateLimit-Reset: 1753490100
Retry-After: 847
Content-Type: application/json

{
  "error": "too many auth attempts; try again in 15 minutes"
}
```

For authenticated session routes the response body is:

```json
{ "error": "too many requests; try again shortly" }
```

> **Note on headers:** The API sets `RateLimit-*` standard draft headers (`standardHeaders: true`) and does **not** set legacy `X-RateLimit-*` headers. The `Retry-After` header value is in seconds.

---

## Special case: account lockout

After repeated failed login attempts the auth route can lock an account for 30 minutes and return:

```
HTTP/1.1 429 Too Many Requests

{ "error": "too many failed attempts, account locked for 30 minutes" }
```

This lock is per-account (not per-IP) and is separate from the IP-level rate limit.

---

## How to handle 429 in your client

### Minimal backoff

Read `Retry-After` from the response headers and wait that many seconds before retrying:

```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) return res;

    if (attempt === maxRetries) return res; // give up

    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  throw new Error('unreachable');
}
```

### Recommended: exponential backoff with jitter

For production integrations, prefer exponential backoff so retries from multiple clients do not fire simultaneously after the window resets:

```typescript
async function fetchWithBackoff(url: string, options: RequestInit): Promise<Response> {
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) return res;
    if (attempt === MAX_RETRIES) return res;

    // Honour Retry-After if present, otherwise use exponential backoff with jitter
    const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '0', 10);
    const backoffMs = retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(1000 * 2 ** attempt + Math.random() * 500, 30_000);

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw new Error('unreachable');
}
```

### Tips

- **Cache tokens** — the 20-request / 15-minute window on `/auth/login` is meant for interactive users, not automation. Machine-to-machine integrations should use a long-lived API key (see [API Authentication](./authentication.md)) instead of re-logging in on every request.
- **Share a single session** — if multiple workers share the same credentials, have them share the session token rather than each obtaining their own. The session limiter (60 req / 1 min) is generous for a single worker but can be saturated by a fleet of workers all calling `/auth/me`.
- **Avoid polling `/auth/me`** — use this endpoint only on startup. Continuous polling against the authenticated session limit wastes quota.

---

## Related docs

- [API Authentication](./authentication.md)
- [API Error Codes](./error-codes.md)
