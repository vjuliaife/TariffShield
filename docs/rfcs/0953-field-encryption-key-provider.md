# RFC 0953: `KeyProvider` seam in `field-encryption.ts`

- Status: Proposed
- Issue: #953

## Summary

Extract key derivation behind a `KeyProvider` interface (`getKey(version):
Buffer`), selected once at startup from config. Ship `LocalHashKeyProvider`
(today's behaviour, unchanged) and a stub `KmsKeyProvider` that throws
`KmsNotConfiguredError` rather than silently pretending. `encryptField` /
`decryptField` keep their exact signatures, so **no call site changes** — which
is the point: the KMS migration then touches one file instead of every caller.

## 1. Current state

### 1.1 `getKey()` — `apps/api/src/lib/field-encryption.ts:12-20`

```ts
function getKey(version: number): Buffer {
  const raw = env.FIELD_ENCRYPTION_KEY ?? '';
  if (!raw || raw.length < 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be at least 32 characters');
  }
  // Derive a version-specific key by hashing the base key + version.
  // In production, replace with AWS KMS GenerateDataKey for each version.
  return crypto.createHash('sha256').update(`${raw}:v${version}`).digest();
}
```

Properties worth stating before changing anything, because they are the
contract a `KeyProvider` must preserve:

1. **Deterministic and pure.** Same `(raw, version)` always yields the same
   32-byte key. `decryptField` depends on this: a record encrypted at version 1
   must decrypt identically after a restart, on a different host, and in a
   different process.
2. **Not versioned by content.** `version` is mixed in with a `:` separator, so
   versions cannot collide (`v1`/`v01` would differ from `v1`/`v1`).
3. **32 bytes out of SHA-256**, matching `ALGORITHM = 'aes-256-gcm'` (line 9).
4. **Not constant-time-comparable**, but that is irrelevant: it is a
   deterministic derivation, not a comparison.
5. **Throws on missing/short key.** `env.FIELD_ENCRYPTION_KEY` is
   `z.string().min(32).optional()` (`config/env.ts:168-174`), so `undefined` is
   a legal config value and the check lives here, not in the schema. Moving to a
   provider must keep that check.
6. **The KMS comment (lines 5, 18) is aspirational.** `FIELD_ENCRYPTION_KEY` is
   a static env string. Anyone reading line 18 could reasonably believe a KMS
   path exists.

`CURRENT_KEY_VERSION` (line 22) is `Number(env.FIELD_ENCRYPTION_KEY_VERSION ?? 1)`;
the schema already coerces to a positive int defaulting to 1
(`config/env.ts:175-179`).

### 1.2 Callers — exactly four, in two files

`getKey` is module-private, so the full blast radius is `encryptField` and
`decryptField`, reachable only through four exported functions:

| Caller | Location | Calls |
| --- | --- | --- |
| `jobs/reencrypt-fields.ts` | lines 3-7 (import), 33, 34 | `decryptField`, `encryptField` |
| `routes/kyc.ts` | line 11 (import), 25, 30 | `encryptFieldToJson`, `decryptFieldFromJson` |

```ts
// apps/api/src/jobs/reencrypt-fields.ts:30-39
const oldValue: EncryptedValue = JSON.parse(row.ein_encrypted);
const plaintext = decryptField(oldValue);
const newValue = encryptField(plaintext);
await pool.query(
  `UPDATE importers SET ein_encrypted = $1, ein_key_version = $2 WHERE id = $3`,
  [JSON.stringify(newValue), CURRENT_KEY_VERSION, row.id]
);
```

```ts
// apps/api/src/routes/kyc.ts:24-31
function encryptIfKey(key: string | null): string | null {
  return encryptFieldToJson(key) ?? key;
}
// ...
return decryptFieldFromJson(encrypted) ?? encrypted;
```

So: **2 files, 4 functions, 4 call sites.** The issue's premise — "the eventual
KMS swap will require touching every call site" — is accurate in kind but small
in degree. The real cost is not editing 4 lines; it is that `getKey` has no
interface, so the *shape* of the dependency is invisible, and the KMS work will
arrive as a diff that touches key derivation, error handling, caching, and the
rotation job at the same time.

### 1.3 A third file is coupled to the key, and this is the load-bearing constraint

`apps/api/src/db.ts:530-542`:

```sql
CREATE TABLE IF NOT EXISTS field_encryption_key_versions (
  key_version INTEGER PRIMARY KEY,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  notes TEXT
);
INSERT INTO field_encryption_key_versions (key_version, notes)
  VALUES (1, 'initial key version') ON CONFLICT (key_version) DO NOTHING;

ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_encrypted TEXT;
ALTER TABLE importers ADD COLUMN IF NOT EXISTS
  ein_key_version INTEGER REFERENCES field_encryption_key_versions(key_version);
```

`ein_key_version` carries a **foreign key** into a table of registered key
versions. Two consequences the RFC has to respect:

- `encryptField` writes `key_version: CURRENT_KEY_VERSION` into the ciphertext
  JSON, and the job writes the same value to `ein_key_version`. The FK means
  **any version a provider can produce must exist as a row in
  `field_encryption_key_versions`**, or the `UPDATE` in `reencrypt-fields.ts:37`
  fails. A KMS provider that derives a key for an unregistered version produces
  ciphertext the database will reject.
- `decryptField` is called with `value.key_version` read from that JSON, which
  for pre-existing rows may be absent. Version tagging is therefore not optional
  and not provider-local.

This is the single most important thing the abstraction must not break, and it
is invisible in `field-encryption.ts` today.

### 1.4 Two live gaps found while surveying

Neither is in scope for this RFC; both are recorded because the abstraction
makes them visible and they should not be silently absorbed.

1. **`reencryptImporterEins` is never called.** It is exported at
   `jobs/reencrypt-fields.ts:14` and referenced nowhere in the repo. It is not in
   the boot sequence in `index.ts:381-410`, which starts 15 jobs and not this
   one. So `FIELD_ENCRYPTION_KEY_VERSION` can be incremented and **nothing will
   re-encrypt a single row**; old-version ciphertext would only be rewritten the
   next time a user edits their EIN through `routes/kyc.ts`. Key rotation is
   currently a manual, partial, per-user-triggered operation. The abstraction is
   what makes this fixable without a rewrite — file a separate issue.
2. **`FIELD_ENCRYPTION_KEY` is absent from `.env.example`.** It is in
   `config/env.ts` and documented in the schema description, but a fresh
   `cp .env.example .env` produces a config where every `encryptField` call
   throws `FIELD_ENCRYPTION_KEY must be at least 32 characters`. Same fix,
   separate issue.

## 2. The `KeyProvider` interface

```ts
// apps/api/src/lib/field-encryption.ts (or a new key-provider.ts)

export interface KeyProvider {
  /** Stable identifier recorded in logs and in `field_encryption_key_versions.notes`. */
  readonly name: string;

  /**
   * Return the 32-byte AES-256 key for `version`.
   * MUST be deterministic: the same version must yield the same bytes on every
   * call, in every process, for the lifetime of the data. This is the single
   * invariant `decryptField` depends on.
   *
   * @throws KeyUnavailableError when the key for `version` cannot be produced.
   */
  getKey(version: number): Buffer;
}
```

`getKey(version: number): Buffer` is exactly the signature the issue proposes,
and it is the only method. Deliberately excluded:

- **No `rotate()`.** Rotation is a `CURRENT_KEY_VERSION` bump plus a job, not a
  provider capability. Putting it on the interface would imply the provider owns
  the lifecycle, and `field_encryption_key_versions` already does.
- **No `encrypt`/`decrypt`.** Providers supply keys, not ciphertext. Keeping
  crypto in one module means the AES-GCM envelope format stays uniform across
  providers — critical, because a record must stay readable if the provider
  changes (see §4).
- **No async.** `LocalHashKeyProvider` is synchronous, and the callers
  (`encryptField` in a request handler, `decryptField` in a loop) are written
  synchronously. Adding `Promise` would make every call site `await` for no
  benefit today and would be a lie about the future — a real KMS call *is*
  async, which is precisely why `KmsKeyProvider` will force this interface to
  grow. See §6.

## 3. Construction and injection

`config/env.ts` is the only place that reads process configuration, so it is
where the provider is chosen. Add:

```ts
// apps/api/src/config/env.ts (additions)
FIELD_ENCRYPTION_KEY_PROVIDER: z
  .enum(['local-hash', 'kms'])
  .default('local-hash')
  .describe('Key derivation strategy for field encryption (#314)'),
```

and a single module-level provider in `field-encryption.ts`:

```ts
// apps/api/src/lib/field-encryption.ts
let provider: KeyProvider = createKeyProvider(env);

function createKeyProvider(e: typeof env): KeyProvider {
  switch (e.FIELD_ENCRYPTION_KEY_PROVIDER) {
    case 'kms':
      return new KmsKeyProvider({ region: e.AWS_REGION, keyId: e.FIELD_ENCRYPTION_KMS_KEY_ID });
    case 'local-hash':
    default:
      return new LocalHashKeyProvider(e.FIELD_ENCRYPTION_KEY ?? '');
  }
}

/** Test seam — lets a test install a provider without touching env. */
export function __setKeyProviderForTests(p: KeyProvider): void {
  provider = p;
}
```

Choosing the provider **once at module load** is the important decision. The
alternative — a provider parameter on every `encryptField` call — is what the
issue asks to avoid, and it would push a KMS-availability concern into every
route handler. A module-level singleton means:

- `getKey` becomes a one-line delegation inside the existing private function,
  so `encryptField`/`decryptField` bodies are untouched.
- A misconfigured provider fails at boot (or on first use), not on the first
  unlucky request.
- `config/env.ts` stays the only config reader, so there is one place to look
  when asking "where does the key come from".

Because `env` is a parsed, frozen module export, `createKeyProvider` runs once
per process. That is correct for both providers: `LocalHashKeyProvider` is
stateless, and `KmsKeyProvider` should hold a cached client (§4).

## 4. The two providers

### 4.1 `LocalHashKeyProvider` — today's behaviour, byte-identical

```ts
export class LocalHashKeyProvider implements KeyProvider {
  readonly name = 'local-hash';
  constructor(private readonly baseKey: string) {}

  getKey(version: number): Buffer {
    if (!this.baseKey || this.baseKey.length < 32) {
      throw new Error('FIELD_ENCRYPTION_KEY must be at least 32 characters');
    }
    return crypto.createHash('sha256').update(`${this.baseKey}:v${version}`).digest();
  }
}
```

The error message is preserved verbatim so existing operator runbooks and alerts
matching on it keep working. The `sha256(baseKey + ':v' + version)` construction
is unchanged, so **existing ciphertext stays readable with no migration**. That
compatibility guarantee is the reason this is a refactor and not a rewrite.

### 4.2 `KmsKeyProvider` — stub only, no real KMS calls

```ts
export class KeyUnavailableError extends Error {
  constructor(readonly version: number, cause?: unknown) {
    super(`no encryption key available for version ${version}`, { cause });
    this.name = 'KeyUnavailableError';
  }
}

export class KmsKeyProvider implements KeyProvider {
  readonly name = 'kms';
  constructor(private readonly opts: { region?: string; keyId?: string }) {}

  getKey(version: number): Buffer {
    // Intentionally not implemented. Selecting FIELD_ENCRYPTION_KEY_PROVIDER=kms
    // must fail loudly at first use rather than silently fall back to local
    // derivation, which would write ciphertext the API cannot later read.
    throw new KeyUnavailableError(version);
  }
}
```

The stub throws rather than returning a placeholder or falling back. A silent
fallback is the one genuinely dangerous option here: it would produce locally
derived ciphertext tagged `key_version: N` that a real KMS deployment could not
decrypt, and the failure would surface weeks later during a restore.

`KmsKeyProvider` should also be explicit about the two things that make it a
real change rather than a drop-in:

- **`GenerateDataKey` returns plaintext key material.** Under a real KMS the
  provider caches by `version` and re-`GenerateDataKey`s on miss. The cache
  makes the sync interface viable; the miss path is the async problem in §6.
- **Cache invalidation is a rotation concern.** Key *material* rotation and key
  *version* rotation are different operations, and only the latter is
  `CURRENT_KEY_VERSION`.

## 5. `key_version` tagging and `reencrypt-fields.ts` under the abstraction

The tagging contract is what makes rotation possible, so it must be preserved
exactly. Requirements the RFC commits to:

1. `encryptField` continues to stamp `key_version: CURRENT_KEY_VERSION`
   (`field-encryption.ts:41`). Unchanged.
2. `decryptField` continues to read the key from `value.key_version`, not from
   `CURRENT_KEY_VERSION` (line 46). This is what allows a process to read records
   written by an older version. Unchanged.
3. `EncryptedValue` keeps its exact shape (lines 24-29) — it is the on-disk
   format in `importers.ein_encrypted` and in KYC rows. A new field would need a
   migration; there is none planned.
4. **Ciphertext stays provider-independent.** AES-256-GCM with a 12-byte IV
   stays in `encryptField`/`decryptField`. Because a record stores only
   `key_version`, a record written by `local-hash` is readable by a `kms`
   provider **only if** that provider is asked for the same `version` and the
   data key for that version is still retrievable. This constrains the KMS
   design (§6) and is the reason `field_encryption_key_versions` matters.
5. `reencrypt-fields.ts` needs **no change**. It imports `encryptField`,
   `decryptField`, `CURRENT_KEY_VERSION` and the `EncryptedValue` type, all of
   which keep their signatures. It reads `ein_key_version` from
   `field_encryption_key_versions`-constrained rows and writes
   `CURRENT_KEY_VERSION` back, so the FK from §1.3 is satisfied as long as the
   new version is registered.

That last point is the concrete answer to "define how `key_version` tagging and
`reencrypt-fields.ts` continue to work": the job is provider-agnostic because it
only ever moves a value *forward* through versions, and the provider is only
consulted for a specific version number.

**One new invariant to state explicitly.** Under `local-hash`, deriving the key
for version 5 is free, so forgetting to register version 5 in
`field_encryption_key_versions` only breaks the FK on write. Under KMS,
forgetting to register it means the data key may not exist at all. So the
provider contract should be documented as: *a version is usable only once a row
exists in `field_encryption_key_versions`.* The natural enforcement is a startup
assert that `CURRENT_KEY_VERSION` is registered:

```ts
// in the boot path, or as a check in the rotation job
const r = await pool.query(
  'SELECT 1 FROM field_encryption_key_versions WHERE key_version = $1',
  [CURRENT_KEY_VERSION]
);
if (!r.rowCount) {
  throw new Error(
    `FIELD_ENCRYPTION_KEY_VERSION=${CURRENT_KEY_VERSION} is not registered in ` +
      `field_encryption_key_versions; INSERT it before encrypting with it`
  );
}
```

This is a small addition and it converts a confusing FK violation at write time
into a clear error at boot. It also gives the dead rotation job (§1.4) the
guardrail it lacks.

## 6. Trade-offs

**For the seam now.**

- The change is genuinely small: one interface, two classes, one factory, one
  `getKey` body reduced to a delegation. Roughly 60 added lines, **zero changed
  call sites**, zero migration, byte-identical ciphertext.
- It makes the KMS comment (line 18) true in structure. Today that comment is a
  promise with no code behind it; after this RFC there is a named type and a
  config flag, so the next engineer can see the seam rather than infer it.
- It forces the `field_encryption_key_versions` FK (§1.3) and the
  `key_version` tagging contract (§5) into writing, where they are currently
  implicit. Both are the kind of invariant that is lost the first time someone
  refactors `decryptField` for unrelated reasons.
- `__setKeyProviderForTests` removes the need to set `FIELD_ENCRYPTION_KEY` to
  exercise encryption paths in tests.

**Against.**

- An indirection with one implementation is, today, unnecessary. A reviewer who
  disagrees with this RFC has a fair point: `getKey` is 8 lines.
- The `KeyProvider` interface being synchronous is a constraint that KMS will
  break. A real `GenerateDataKey` is a network call, so the interface will
  likely become `getKey(version): Promise<Buffer>`, which makes `encryptField`
  async, which makes `routes/kyc.ts`'s `encryptIfKey` (line 24) async, which
  makes `encryptFieldToJson` async, which changes those two call sites anyway.
  **The seam defers that change; it does not avoid it.** Being honest about
  this is the main argument for doing the async version now if the KMS work is
  committed — see §7.
- `KmsKeyProvider` is dead code that throws. It will rot. Mitigation: it is 8
  lines, and it is better than a comment because it is discoverable from
  `createKeyProvider`.

**Rejected: inject the provider as a parameter** (`encryptField(plaintext,
provider)`). Explicit, testable, no module state — and it puts a
`KeyProvider` argument on every call site, which is the thing the issue is
trying to avoid, for 4 call sites today and 4 more the moment
`importer_team_members` or compliance flags need encrypting.

**Rejected: pass a `KeyResolver` function** instead of an interface.
`getKey: (version: number) => Buffer` is less ceremony, but a named interface
gives the KMS implementation somewhere to hang `name`, caching and
`KeyUnavailableError` without inventing a second concept later.

**Rejected: defer until KMS starts.** The cost of the KMS migration under time
pressure is precisely the thing the issue names. Doing it later means doing it
while also debugging KMS credentials, cache behaviour and rotation, on a
function that guards EINs.

## 7. Open questions

1. **Sync or async `getKey` now?** If the KMS migration is committed rather than
   speculative, the interface should be `Promise<Buffer>` from the start, and
   `encryptField`/`decryptField` become async. That is a 2-call-site change
   (`routes/kyc.ts:25,30`) plus the job's `await`s. Cheaper now than later.
2. **Should `LocalHashKeyProvider` stay the default in production?** If yes,
   nothing changes operationally. If the intent is to make KMS mandatory before
   launch, that is a deployment decision, not an RFC decision — but it changes
   whether this RFC is a seam or the first step of a migration.
3. **Should the boot-time `field_encryption_key_versions` registration assert
   (end of §5) ship in this change?** It is a behaviour change (a new failure
   mode at boot), but it belongs with the abstraction that makes it expressible.
4. What should `field_encryption_key_versions.notes` record under a provider
   name? The `KeyProvider.name` field (`'local-hash'` / `'kms'`) is there to
   make that possible; whether to write it on every `reencrypt` run is a
   separate operational question.
