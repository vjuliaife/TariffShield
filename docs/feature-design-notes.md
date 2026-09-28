# Feature Design Notes

Design specs for importer- and admin-facing features: the data model, API
surface and UI each one was built around. For the system as a whole, see
[ARCHITECTURE.md](../ARCHITECTURE.md). For what changed in each release, see
[CHANGELOG.md](../CHANGELOG.md).

---

## 1. Importer Sub-Account / Team Member Invites with Role-Based Permissions (#1015)

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

## 2. Configurable Alert Thresholds for Collateral Health Score (#1017)

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

## 3. Bulk Oracle Signer Rotation Workflow UI for Surety Admins (#1018)

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

## 4. Historical Tariff Rate Trend Charting on Importer Dashboard (#1019)

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
