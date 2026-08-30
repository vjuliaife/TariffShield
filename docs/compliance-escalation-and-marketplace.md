# Compliance Escalation and Surety Marketplace

This document describes the implementation of two new features:

- **Issue #1034**: Automated Escalation Rules for Unresolved Compliance Flags
- **Issue #1036**: Surety Partner Rate Comparison Marketplace

## Compliance Escalation (Issue #1034)

### Overview

Automated escalation rules ensure that compliance flags do not sit unresolved beyond configured time thresholds. When a flag exceeds its age threshold, it is automatically escalated with increased priority and reassigned to a senior admin.

### Database Schema

**compliance_escalation_rules**

- `id`: Unique identifier
- `surety_id`: Reference to the surety admin who owns the rule
- `age_threshold_hours`: Time threshold after which flags are escalated
- `escalation_target_role`: Either 'senior_admin' or 'specific_user'
- `escalation_target_user_id`: Specific user to escalate to (if role is 'specific_user')
- `is_active`: Whether the rule is currently active

**compliance_escalation_history**

- Tracks every escalation event for audit purposes
- Records previous and new assignees, escalation rule used, and timestamp

### API Endpoints

**GET /compliance/escalation-rules**

- List all escalation rules for the authenticated surety admin

**POST /compliance/escalation-rules**

- Create a new escalation rule
- Body: `{ age_threshold_hours, escalation_target_role, escalation_target_user_id? }`

**PUT /compliance/escalation-rules/:id**

- Update an existing escalation rule

**DELETE /compliance/escalation-rules/:id**

- Delete an escalation rule

**GET /compliance/escalation-history/:flagId**

- View escalation history for a specific compliance flag

### Automated Job

The `startComplianceEscalation()` job runs every 15 minutes:

1. Fetches all active escalation rules
2. Identifies flags exceeding age thresholds that haven't been escalated
3. Updates flag status to 'escalated' and bumps priority
4. Reassigns to the configured target admin
5. Records escalation in history table
6. Sends notification to the escalation target

### Priority Escalation Logic

- `low` → `medium`
- `medium` → `high`
- `high` → `critical`
- `critical` → remains `critical`

## Surety Marketplace (Issue #1036)

### Overview

The marketplace allows importers to browse and compare surety partners before onboarding. Surety partners can publish their rate terms and importers can filter/compare by collateral ratio, coverage type, and state licensing.

### Database Schema

**surety_marketplace_partners**

- `id`: Unique identifier
- `surety_id`: Reference to the surety admin (unique)
- `company_name`, `naic_number`, `am_best_rating`: Company details
- `collateral_ratio`: Required collateral percentage
- `coverage_types`: Array of supported bond types
- `base_premium_rate`: Base premium rate
- `description`: Marketing description
- `min_bond_amount`, `max_bond_amount`: Bond amount range
- `states_licensed_count`: Number of states licensed in
- `contact_email`, `contact_phone`, `website_url`: Contact information
- `stellar_contract_address`: On-chain contract address
- `is_active`, `is_published`: Visibility controls

### API Endpoints

#### Public/Importer Endpoints

**GET /surety-marketplace**

- List available surety partners
- Query params: `min_collateral_ratio`, `max_collateral_ratio`, `coverage_type`, `state_licensed`, `sort`
- Returns partners with disclaimer about informational nature

**GET /surety-marketplace/:id**

- Get detailed information for a specific partner
- Includes contact details and licensed states

#### Admin Endpoints

**POST /surety-marketplace/admin**

- Create or update own marketplace listing
- Automatically pulls company details from license verification
- Body: `{ collateral_ratio, coverage_types, base_premium_rate, description, ... }`

**GET /surety-marketplace/admin/my-listing**

- View own marketplace listing

**PUT /surety-marketplace/admin/publish**

- Toggle publish status
- Body: `{ is_published: boolean }`

### Integration with Onboarding

When an importer selects a surety partner from the marketplace:

1. The partner's `stellar_contract_address` is used
2. The existing `register_importer` flow is followed
3. The importer onboards with that specific surety instance

### Disclaimers

The marketplace includes clear disclaimers that:

- Rates are informational and not binding quotes
- Importers should contact sureties directly for official quotes
- Information should be verified before making decisions

## Testing

### Escalation Rules

```bash
# Create an escalation rule
curl -X POST http://localhost:3001/compliance/escalation-rules \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"age_threshold_hours": 72, "escalation_target_role": "senior_admin"}'

# List rules
curl http://localhost:3001/compliance/escalation-rules \
  -H "Authorization: Bearer <token>"
```

### Marketplace

```bash
# Browse marketplace
curl http://localhost:3001/surety-marketplace?sort=collateral_ratio \
  -H "Authorization: Bearer <token>"

# Create listing (surety admin)
curl -X POST http://localhost:3001/surety-marketplace/admin \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "collateral_ratio": 1.25,
    "coverage_types": ["continuous"],
    "base_premium_rate": 0.0125,
    "description": "Competitive rates for importers",
    "min_bond_amount": 50000,
    "max_bond_amount": 10000000,
    "contact_email": "quotes@surety.com"
  }'
```

## Migration

Run the SQL migration to create the necessary tables:

```bash
psql $DATABASE_URL < apps/api/migrations/009_compliance_escalation_and_marketplace.sql
```

## Monitoring

- Escalation job logs escalation events with `compliance_escalation` log entries
- Check `compliance_escalation_history` table for audit trail
- Monitor notifications table for escalation alerts sent to admins
