# TariffShield Issue Implementations

This document tracks the implementations completed to resolve issues #289, #285, #283, and #288.

---

## 1. Issue #289: Mermaid Architecture Diagrams

We added three Mermaid diagrams to [ARCHITECTURE.md](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/ARCHITECTURE.md) to describe system topology and key sequence flows.

### System Topology Diagram
A top-down (`graph TD`) layout showing the flow of communication:
* Browser/Client UI connects to the Next.js Frontend (Vercel) via HTTPS.
* Next.js Frontend connects to the Express API (Render) via HTTPS / JWT.
* Express API connects to the PostgreSQL Database (CRM mirror) via SQL.
* Express API invokes the SDK (`TariffShieldClient`), which calls the Soroban Contract via Soroban RPC JSON-RPC protocols.
* A clear line style legend was added at the bottom: solid lines represent synchronous calls, while dashed lines represent asynchronous event emissions and indexing.

### Sequence Diagram: Tariff Spike & Auto-Top-Up Flow
A diagram showing how the system acts when a tariff spike occurs:
* `CBP Webhook` pushes CSV/estimates to the `Express API`.
* `Express API` saves the `tariff_upload` to `PostgreSQL`.
* `Express API` calculates and invokes `setRequiredCollateral` on-chain using the `TariffShieldClient` SDK.
* If a collateral shortfall is detected, the `Express API` invokes `autoTopUp` on-chain.
* The `TariffShieldContract` moves funds from reserve to collateral, emits the `topup` event, which the `Express API` captures and mirrors into the `contract_events` database log.

### Sequence Diagram: Surety Admin Clawback Flow
A diagram showing the emergency clawback procedure:
* The `Surety Admin UI` requests a clawback action.
* The `Express API` performs role-based authorization verification (`surety_admin`).
* The API invokes the `clawback` method on the `TariffShieldClient` SDK.
* The SDK calls `clawback` on `TariffShieldContract`, draining balances to the surety wallet and freezing the account.
* The contract emits a `clawback` event, which is mirrored by the `Express API` to the database audit logs.
* A response is returned back to the UI.

---

## 2. Issue #285: CI Formatting and Clippy Lints Gate

We created a linting gate for contract Rust code.
* **Format Configuration**: Created [rustfmt.toml](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/rustfmt.toml) in the repository root to specify strict format limits (`max_width = 100` and `edition = "2021"`).
* **CI Integration**: Modified [.github/workflows/ci.yml](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/.github/workflows/ci.yml) to include parallel `fmt` and `clippy` jobs. Both jobs utilize the same cargo cache keys as the test job to avoid rebuilding dependencies.
* **Pre-commit Hook Suggestion**: Added explicit guidelines on configuring a local git `pre-commit` hook to automatically check Rust formatting locally in [CONTRIBUTING.md](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/CONTRIBUTING.md).

---

## 3. Issue #283: Automated Changelog Generation

We integrated the Conventional Commit standard with automated changelog updates.
* **Dependencies**: Added `conventional-changelog-cli` to `devDependencies` in [package.json](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/package.json).
* **Script**: Added a `"changelog"` script: `"conventional-changelog -p angular -i CHANGELOG.md -s"`.
* **Baseline Changelog**: Generated a retroactive, complete history from commit history in [CHANGELOG.md](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/CHANGELOG.md) using `npx conventional-changelog -p angular -i CHANGELOG.md -s -r 0`.
* **Readme Reference**: Linked the changelog within [README.md](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/README.md) under the "Changelog" heading.

---

## 4. Issue #288: Deployment and Verification Guide

We wrote a detailed step-by-step deploy runbook in [docs/deployment.md](file:///c:/Users/PAB-NETWORK/Downloads/TariffShield/docs/deployment.md).
* **Prerequisites**: Clearly listed tools and version bounds for Node.js 20, Rust target wasm32, Stellar CLI, Docker, and Render/Vercel platforms.
* **Env Config Reference**: Mapped out a table of all environment variables for both API and Web configurations with example values, validation types, and risk levels.
* **Soroban Commands**: Documented commands for compiling (`cargo build`), optimizing (`stellar contract optimize`), deploying (`stellar contract deploy`), and initializing (`stellar contract invoke`) on testnet/mainnet.
* **Render & Vercel**: Provided templates for `render.yaml` service settings, instructions to deploy containerized APIs on Render, and linking/deploying web assets using `vercel --prod`.
* **Post-Deploy Smoke Tests**: Outlined three checks to verify API health (`/health`), sign up (`/auth/signup`), and inspect on-chain account state (`get_account`).
* **Rollback Actions**: Outlined rollback steps for Vercel, Render revisions, and multi-sig Soroban contract upgrades via `propose_upgrade`.

---

## 5. Issue #1015: Importer Sub-Account / Team Member Invites with Role-Based Permissions

### Architecture & System Design
To enable importer organization staff (finance, compliance, ops) to collaborate under a unified importer account without sharing credentials, we introduce a hierarchical Sub-Account and Team Member RBAC architecture.
* **Owner Account**: The primary user who created the importer profile. Retains full administrative governance.
* **Team Members**: Invited users associated with an importer profile via the `importer_team_members` junction table.
* **Role-Based Access Control (RBAC)**:
  * `admin`: Can perform all actions including managing team members, inviting staff, revoking access, configuring collateral settings, and executing deposits/withdrawals.
  * `finance`: Permitted to manage deposits, reserves, view metrics, and adjust auto-top-up settings. Restricted from revoking owner access or altering organization settings.
  * `viewer`: Read-only access to dashboard data, metrics, events, and reports. All state-mutating requests (`POST`, `PUT`, `DELETE`) return `403 Forbidden`.

### Database Schema Expansion (`migrations/015_importer_team_members.sql`)
```sql
CREATE TYPE team_member_role AS ENUM ('admin', 'finance', 'viewer');
CREATE TYPE team_member_status AS ENUM ('pending', 'active', 'revoked');

CREATE TABLE importer_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255) NOT NULL,
    role team_member_role NOT NULL DEFAULT 'viewer',
    status team_member_status NOT NULL DEFAULT 'pending',
    invite_token_hash VARCHAR(64) UNIQUE,
    invited_by UUID NOT NULL REFERENCES users(id),
    invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT unique_importer_member_email UNIQUE (importer_id, email)
);

CREATE INDEX idx_team_members_importer_status ON importer_team_members(importer_id, status);
CREATE INDEX idx_team_members_user ON importer_team_members(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_team_members_invite_hash ON importer_team_members(invite_token_hash) WHERE invite_token_hash IS NOT NULL;
```

### Backend Implementation (`apps/api/src/routes/importers.ts` & `apps/api/src/routes/auth.ts`)
1. **Team Invites (`POST /importers/:id/members/invite`)**:
   * Owner/Admin posts an email and role.
   * Generates a cryptographically secure token (`randomBytes(32)`), stores `sha256(token)` in `invite_token_hash`.
   * Sends invitation email with accept link.
   * Audited via `logAudit(user.id, 'team_member_invited', importerId, { email, role })`.

2. **Invite Acceptance (`POST /auth/team-invite/accept`)**:
   * User provides invite token, email, and password (or logs in).
   * Validates token hash match and status `'pending'`.
   * Links `user_id`, sets status to `'active'`, records `accepted_at`.
   * Issues JWT session scoped with `importerId` and `teamRole`.

3. **RBAC Permission Middleware (`requireImporterRole(allowedRoles)`)**:
   * Evaluates user's membership role for the requested `importerId`.
   * Enforces method restrictions (e.g., `viewer` blocked from `POST /importers/:id/withdraw`).

4. **Revocation (`DELETE /importers/:id/members/:memberId`)**:
   * Owner/Admin sets status to `'revoked'`, populates `revoked_at`.
   * Immediately invalidates active team member sessions.
   * Audited via `logAudit(user.id, 'team_member_revoked', importerId, { memberId })`.

5. **Individual Audit Attribution**:
   * Every audit log entry records `user_id` (the individual team member), `importer_id`, action type, and IP address for compliance tracking.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Member Authorization Check: $O(1)$ indexed lookup on `idx_team_members_importer_status` / `idx_team_members_user`.
  * Invite Token Validation: $O(1)$ indexed hash lookup.
* **Space Complexity**: $O(M)$ where $M$ is the number of team members per importer account.

---

## 6. Issue #1017: Configurable Alert Thresholds for Collateral Health Score

### Architecture & System Design
Importers require proactive notifications when collateral coverage or reserve levels fluctuate near critical limits. We implement configurable per-importer threshold settings while retaining fallback defaults.
* **Default Thresholds**: Warning at score $< 60$, Critical at score $< 40$.
* **Validation Bounds**: Enforces $0 \le \text{critical\_threshold} < \text{warning\_threshold} \le 100$.
* **Alert Engine**: Evaluates health score state transitions (`NORMAL` $\rightarrow$ `WARNING` $\rightarrow$ `CRITICAL`) and dispatches notifications via `createNotification` avoiding duplicate spamming.

### Database Schema Expansion (`migrations/017_importer_health_thresholds.sql`)
```sql
CREATE TABLE importer_health_thresholds (
    importer_id UUID PRIMARY KEY REFERENCES importers(id) ON DELETE CASCADE,
    warning_threshold INT NOT NULL DEFAULT 60 CHECK (warning_threshold BETWEEN 1 AND 100),
    critical_threshold INT NOT NULL DEFAULT 40 CHECK (critical_threshold BETWEEN 0 AND 99),
    last_notified_state VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_threshold_bounds CHECK (critical_threshold < warning_threshold)
);
```

### Backend & Alert Pipeline (`apps/api/src/routes/notifications.ts` & `apps/api/src/services/credit-lines.ts`)
1. **GET/PUT Threshold Settings Endpoint (`/notifications/thresholds/:importerId`)**:
   * `GET`: Returns stored thresholds or defaults `{ warningThreshold: 60, criticalThreshold: 40 }`.
   * `PUT`: Validates input with Zod schema (`critical < warning`), upserts record in `importer_health_thresholds`, logs audit entry.

2. **Proactive Health Monitoring Service**:
   * On collateral changes (or scheduled health checks), calculates:
     $$\text{CoverageScore} = \min\left(100, \frac{\text{Collateral}}{\text{Required}} \times 100\right)$$
     $$\text{ReserveScore} = \min\left(100, \frac{\text{Reserve}}{\text{Collateral}} \times 100\right)$$
     $$\text{HealthScore} = \text{Math.round}(\text{CoverageScore} \times 0.7 + \text{ReserveScore} \times 0.3)$$
   * Compares `HealthScore` against thresholds.
   * If state changes to `WARNING` or `CRITICAL`, invokes `createNotification` with `NOTIFICATION_KINDS.HEALTH_SCORE_THRESHOLD_BREACH`.

### Frontend Component (`apps/web/components/HealthScore.tsx`)
* Surfaces an interactive "Configure Alert Thresholds" gear button next to the Health Score breakdown.
* Displays a slider control allowing importers to tune Warning and Critical bounds with real-time feedback.
* Visual indicators on the progress bar reflect custom threshold markers.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Threshold Evaluation: $O(1)$ arithmetic operations.
  * Settings Retrieval/Update: $O(1)$ primary key lookup in PostgreSQL.
* **Space Complexity**: $O(1)$ constant memory overhead per importer.

---

## 7. Issue #1018: Bulk Oracle Signer Rotation Workflow UI for Surety Admins

### Architecture & System Design
Soroban smart contract function `update_oracle_signers(env, new_signers, approvals)` requires a 2-of-3 multi-signature consensus among current signers. We build an administrative workflow service and UI for proposing, tracking, collecting approvals, and executing signer updates on-chain.

### On-Chain Contract Alignment (`contracts/tariff-shield/src/lib.rs`)
The Soroban contract function validates:
1. `new_signers.len() == 3`.
2. Approvals contain $\ge 2$ distinct, authorized signatures from current `OracleSigners`.
3. Updates `OracleSigners` state in instance storage upon valid invocation.

### Database Schema Expansion (`migrations/018_oracle_signer_rotations.sql`)
```sql
CREATE TYPE rotation_status AS ENUM ('proposed', 'pending_signatures', 'executed', 'cancelled');

CREATE TABLE oracle_signer_rotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposed_by UUID NOT NULL REFERENCES users(id),
    new_signers JSONB NOT NULL, -- Array of 3 Stellar public key strings
    threshold INT NOT NULL DEFAULT 2,
    approvals JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array of { signerAddress, signature, approvedAt }
    status rotation_status NOT NULL DEFAULT 'proposed',
    tx_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ
);

CREATE INDEX idx_signer_rotations_status ON oracle_signer_rotations(status);
```

### Admin Workflow & API Endpoints (`apps/api/src/routes/admin.ts`)
1. **Propose Rotation (`POST /admin/oracle-signers/propose`)**:
   * Accepts 3 valid Stellar public key addresses. Verifies uniqueness and valid format.
   * Fetches current signers via `get_oracle_signers()` on-chain.
   * Creates a proposal record with status `'pending_signatures'`.

2. **Submit Approval (`POST /admin/oracle-signers/:id/approve`)**:
   * Surety admin / current oracle signer authenticates and provides cryptographic signature.
   * Validates signature against proposal payload using Stellar SDK.
   * Appends approval entry to `approvals` JSON array.

3. **Execute Rotation (`POST /admin/oracle-signers/:id/execute`)**:
   * Verifies approval count $\ge 2$.
   * Invokes Soroban `update_oracle_signers` via contract client with collected approval signatures.
   * Verifies state update via `get_oracle_signers()`.
   * Sets status to `'executed'`, stores `tx_hash`, logs audit record.

4. **Rotation History (`GET /admin/oracle-signers/history`)**:
   * Returns audit history of previous rotations and current pending proposals.

### Frontend UI Component (`apps/web/components/OracleSignerRotation.tsx`)
* Guided 3-step wizard for Surety Admins:
  1. *Propose New Signer Set*: Form input for 3 Stellar public keys with instant format validation.
  2. *Approval Tracker*: Displays real-time status of each signer's approval (e.g., 1 of 2 required signatures collected).
  3. *On-Chain Execution & Verification*: Triggers contract execution button and displays live transaction link once executed.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Proposal & Signature Verification: $O(S)$ where $S = 3$ signers $\Rightarrow O(1)$.
  * On-Chain Confirmation: $O(1)$ RPC query to Soroban node.
* **Space Complexity**: $O(R)$ where $R$ is historical rotation record count.

---

## 8. Issue #1019: Historical Tariff Rate Trend Charting on Importer Dashboard

### Architecture & System Design
Importers require visibility into how historical duty rates for specific Harmonized Tariff Schedule (HTS) codes have trended over time. We implement a read-only historical analytics service and dashboard line chart.

### Database Indexing Strategy (`migrations/019_hts_rate_history.sql`)
```sql
CREATE TABLE hts_rate_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hts_code VARCHAR(14) NOT NULL,
    duty_rate NUMERIC(7,4) NOT NULL,
    effective_date DATE NOT NULL,
    source VARCHAR(50) NOT NULL DEFAULT 'CBP_DATASET',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_hts_effective_date UNIQUE (hts_code, effective_date)
);

CREATE INDEX idx_hts_rate_history_lookup ON hts_rate_history(hts_code, effective_date ASC);
```

### Analytics Endpoint (`apps/api/src/routes/importers.ts`)
* **`GET /importers/:id/tariff-history`**:
  * Query parameters: `htsCode` (required), `startDate`, `endDate`.
  * Fetches historical data points from `hts_rate_history` for the given HTS code.
  * Joins importer's most recent CSV upload timestamp (`importer_tariff_uploads`) to annotate the user's latest upload event on the timeline.
  * Returns payload:
    ```json
    {
      "htsCode": "8703.23.0100",
      "latestUploadDate": "2026-09-20T14:30:00Z",
      "history": [
        { "date": "2026-01-01", "rate": 0.025 },
        { "date": "2026-06-01", "rate": 0.075 },
        { "date": "2026-09-15", "rate": 0.125 }
      ]
    }
    ```
  * Gracefully handles sparse or empty historical records by returning an empty array without erroring.

### Frontend Chart Component (`apps/web/components/TariffRateChart.tsx`)
* Responsive line chart visualizing rate changes over time.
* Vertical marker highlighting the importer's latest CSV upload date.
* Interactive tooltip displaying date, duty rate percentage, and rate delta since previous record.
* Read-only isolation guarantees zero side effects on collateral math or smart contract logic.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Query Execution: $O(\log N + K)$ using B-tree index `idx_hts_rate_history_lookup`, where $N$ is total historical rate entries and $K$ is the number of points in the date range.
  * Rendering: $O(K)$ canvas/SVG element points.
* **Space Complexity**: $O(K)$ memory footprint for transmitted time-series points.

---

## 9. Issue #1022: Automated Reminder Sequence for Pending Bond Signatures

### Architecture & System Design
To address pending DocuSign envelope sign-offs that leave customs bond issuance stalled, we implement an automated, escalating reminder sequence background worker alongside configurable cadence settings and admin tracking interfaces.
* **Scheduled Reminder Engine**: Polling background service evaluating unsigned envelopes against configurable threshold windows (defaulting to Day 2, Day 5, and Day 7).
* **Escalating Notifications**: Dispatches notifications via `createNotification` (`apps/api/src/routes/notifications.ts`) with appropriate severity levels based on elapsed days. Automatically terminates when `signature_status` becomes `'completed'`, `'declined'`, or `'voided'`.
* **Configurable Cadence**: `surety_admin` can adjust reminder thresholds per surety organization or bond type.
* **History Auditability**: Every reminder event is recorded in `bond_signature_reminders` audit log for surety inspection.

### Database Schema Expansion (`migrations/022_bond_signature_reminders.sql`)
```sql
CREATE TABLE bond_signature_reminder_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    surety_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cadence_days INT[] NOT NULL DEFAULT '{2, 5, 7}',
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT unique_surety_reminder_config UNIQUE (surety_id)
);

CREATE TABLE bond_signature_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bond_record_id UUID NOT NULL REFERENCES bond_records(id) ON DELETE CASCADE,
    envelope_id VARCHAR(255) NOT NULL,
    reminder_number INT NOT NULL, -- 1 = Day 2, 2 = Day 5, 3 = Day 7
    recipient_email VARCHAR(255) NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(50) NOT NULL DEFAULT 'delivered'
);

CREATE INDEX idx_bond_sig_reminders_bond ON bond_signature_reminders(bond_record_id, sent_at DESC);
CREATE INDEX idx_pending_signatures ON bond_signatures(status, created_at) WHERE status = 'sent';
```

### API Implementation (`apps/api/src/routes/bond-signatures.ts`)
1. **GET `/api/v1/bonds/:id/reminders`**:
   * Endpoint restricted to `surety_admin`.
   * Returns historical reminder logs for a specified bond record.
2. **GET/PUT `/api/v1/bonds/reminder-config`**:
   * Enables surety admins to read and update cadence arrays (e.g. `[2, 5, 7]`).
3. **Automated Cron Worker (`processPendingSignatureReminders()`)**:
   * Queries pending envelopes (`WHERE status = 'sent'`).
   * For each envelope, calculates elapsed time: $\Delta t = t_{\text{now}} - t_{\text{created}}$.
   * Evaluates sent count against cadence thresholds; if eligible, dispatches in-app notification & email via `notifications.ts`, updates `last_reminder_sent_at` on `bond_signatures`, and inserts log entry into `bond_signature_reminders`.
   * Automatically skips envelopes where status has moved to `'completed'`.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Polling Pending Signatures: $O(P)$ indexed scan on `idx_pending_signatures` where $P$ is the number of active unsigned envelopes.
  * History Query: $O(\log R + K)$ index lookup on `idx_bond_sig_reminders_bond`.
* **Space Complexity**: $O(R)$ where $R$ is total historical reminder logs.

---

## 10. Issue #1024: Sandbox / Trial Mode Toggle for Prospective Importer Accounts

### Architecture & System Design
Prospective importers require a risk-free trial environment to evaluate bond top-ups, collateral management, and duty ingestion without executing live on-chain Stellar transactions or moving real token funds.
* **Account-Level Sandbox Flag**: `is_sandbox` boolean flag attached to `importers` table.
* **Simulated Execution Engine**: Intercepts `register_importer`, `deposit_collateral`, `deposit_reserve`, and `withdraw_collateral` for sandbox accounts. Updates local database mirror balances directly without broadcasting Soroban RPC transactions to the Stellar network.
* **Visual Distinction**: Frontend dashboard highlights Sandbox Mode with prominent warning banners, distinct badges, and trial state indicators.
* **Live Conversion Workflow**: `surety_admin` or platform admin can execute conversion (`POST /importers/:id/convert-to-live`).
* **Regulatory Exclusivity**: All queries in `apps/api/src/routes/regulatory.ts` explicitly filter `WHERE i.is_sandbox = false` to guarantee trial data is completely excluded from state regulatory reports, compliance filings, and audit logs.

### Database Schema & Query Isolation (`apps/api/src/routes/regulatory.ts`)
```sql
ALTER TABLE importers ADD COLUMN is_sandbox BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE importers ADD COLUMN converted_at TIMESTAMPTZ;
CREATE INDEX idx_importers_sandbox ON importers(is_sandbox);
```

In `apps/api/src/routes/regulatory.ts`:
```sql
-- Explicitly exclude sandbox importer data from regulatory report calculations
SELECT COUNT(*)::text as claims_count
FROM contract_events ce
JOIN importers i ON ce.importer_id = i.id
JOIN bond_records br ON br.importer_id = i.id
WHERE ce.kind = 'clawback'
  AND br.state_code = $1
  AND i.is_sandbox = false
  AND ce.created_at >= $2
  AND ce.created_at <= $3;
```

### Contract Simulation Alignment (`contracts/tariff-shield/src/lib.rs`)
While the Soroban smart contract strictly handles real on-chain token state, the off-chain API layer (`apps/api`) acts as the gateway controller. For `is_sandbox = true` accounts, the API skips contract RPC submission while retaining identical event format mirroring (`contract_events` table) so trial reporting analytics work seamlessly.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Simulated Deposit/Withdrawal: $O(1)$ atomic PostgreSQL transaction (bypasses 3-5s Soroban RPC consensus latency).
  * Regulatory Filtering: $O(1)$ overhead utilizing index `idx_importers_sandbox`.
* **Space Complexity**: $O(S)$ storage for trial importer records.

---

## 11. Issue #1014: Self-Service Multi-Factor Authentication (MFA) Management

### Architecture & System Design
To secure importer and surety administrator accounts beyond standard password authentication, we implement TOTP-based (Time-based One-Time Password) Multi-Factor Authentication with backup recovery code support.
* **Standard Compatibility**: Uses RFC 6238 TOTP algorithms (compatible with Google Authenticator, Authy, 1Password).
* **Enrollment Flow**:
  1. User requests MFA setup -> API generates secret key & QR code URI (`otpauth://`).
  2. API generates 8 single-use cryptographic recovery codes (`randomBytes(4).toString('hex')`), hashed via SHA-256 before DB storage.
  3. User inputs 6-digit TOTP code to confirm setup -> `mfa_enabled` set to `true`.
* **Login Challenge Enforcement**: `POST /auth/login` checks `mfa_enabled`. If true, returns `202 Accepted` with a transient `mfa_ticket` instead of JWT. User completes authentication at `POST /auth/mfa/verify`.
* **Disabling MFA**: Requires current password re-authentication and active TOTP code.
* **Admin Visibility**: `surety_admin` can inspect MFA enrollment status across users (`mfa_enabled`, `mfa_enrolled_at`) for security compliance.

### Database Schema Expansion (`migrations/014_user_mfa.sql`)
```sql
ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN mfa_secret_encrypted TEXT;
ALTER TABLE users ADD COLUMN mfa_enrolled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN mfa_recovery_codes JSONB; -- Array of { code_hash, used_at }

CREATE INDEX idx_users_mfa_status ON users(mfa_enabled);
```

### Authentication Flow Spec (`apps/api/src/routes/auth.ts`)
1. **`POST /auth/mfa/setup`** (Authed): Generates TOTP secret & encrypted storage, returns QR code URI + plain recovery codes.
2. **`POST /auth/mfa/confirm`** (Authed): Validates submitted TOTP token against secret using window $\pm 1$ step (30s). Sets `mfa_enabled = true`.
3. **`POST /auth/login`** (Extended):
   ```typescript
   if (user.mfa_enabled) {
     const mfaTicket = jwt.sign({ userId: user.id, type: 'mfa_challenge' }, env.JWT_SECRET, { expiresIn: '5m' });
     return res.status(202).json({ mfaRequired: true, mfaTicket });
   }
   ```
4. **`POST /auth/mfa/verify`**: Validates `mfaTicket` and 6-digit TOTP or recovery code. On match, issues session JWT and refresh token.

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * TOTP HMAC-SHA1 Computation: $O(1)$ constant time arithmetic operations over secret key.
  * Recovery Code Hash Check: $O(C)$ where $C = 8$ recovery codes $\Rightarrow O(1)$.
* **Space Complexity**: $O(1)$ encrypted secret & recovery hash storage per user.

---

## 12. Issue #1016: In-App Changelog / Release Notes Feed

### Architecture & System Design
To inform importers and surety admins of new feature rollouts, regulatory updates, and platform changes within the product, we add an in-app changelog panel integrated directly into `Nav.tsx`.
* **Admin Content Management**: `surety_admin` / platform admin can publish, edit, or archive release notes entries via `/api/v1/changelog`.
* **Unread Indicator**: `Nav.tsx` polls/fetches the unread changelog count for the logged-in user. Shows a distinct notification badge when unread entries exist (`published_at > last_read_at`).
* **Interactive Panel**: Clicking the indicator toggles a slide-out drawer listing historical entries sorted by date.
* **Per-User Read Persistence**: Persists user read state in `user_changelog_reads` table to synchronize unread states across devices.
* **Rich Text Support**: Entries support Markdown formatting (headings, lists, links) sanitized against XSS attacks.

### Database Schema Expansion (`migrations/016_changelog_feed.sql`)
```sql
CREATE TABLE changelog_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    version VARCHAR(50),
    content_markdown TEXT NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'feature', -- 'feature', 'security', 'compliance', 'maintenance'
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE user_changelog_reads (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id)
);

CREATE INDEX idx_changelog_published ON changelog_entries(published_at DESC);
```

### API Endpoints (`apps/api/src/routes/changelog.ts`)
* **`GET /api/v1/changelog`** (Authed): Returns recent changelog entries and `unreadCount` calculated by comparing entry timestamps against `user_changelog_reads.last_read_at`.
* **`POST /api/v1/changelog/read`** (Authed): Updates `user_changelog_reads.last_read_at = NOW()` for the user, clearing the unread badge.
* **`POST /api/v1/changelog`** (`surety_admin`): Creates a new published changelog entry.

### Frontend Component Integration (`apps/web/components/Nav.tsx`)
* Added `ChangelogDrawer` entry point icon/badge in the navigation bar.
* Displays unread badge when `unreadCount > 0`.
* Seamlessly renders Markdown content using standard React elements with secure link targets (`target="_blank" rel="noopener noreferrer"`).

### Algorithmic Complexity Analysis
* **Time Complexity**:
  * Unread Count Computation: $O(\log E)$ index binary search on `idx_changelog_published` where $E$ is total published changelog entries.
  * Read State Update: $O(1)$ primary key upsert.
* **Space Complexity**: $O(E)$ memory for changelog feed payload.


