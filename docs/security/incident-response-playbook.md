# TariffShield Security Incident Response Playbook

## Overview

This document defines TariffShield's incident response procedures to address security events including data breaches, ransomware, on-chain exploits, and credential compromises. It aligns with SOC 2 Type II CC7.3-CC7.5 and ISO 27001 Annex A.16.1 requirements.

## Incident Classification

Incidents are classified by severity tier and response urgency:

### P0 (Critical)
- Confirmed data breach exposing PII (names, EINs, financial records)
- Active ransomware or malware infection
- Unauthorized access to production database
- On-chain exploit affecting importer accounts
- Regulatory reporting triggered (GDPR, CCPA, state breach law)

Response SLA: 1 hour initial contact, containment within 2 hours

### P1 (High)
- Suspected security compromise requiring investigation
- Failed authentication attempts above threshold
- Unauthorized API access pattern
- Certificate or key compromise
- Denial of service attack

Response SLA: 4 hours investigation start

### P2 (Medium)
- Vulnerability discovered without exploitation evidence
- Configuration weakness detected
- Third-party vendor security advisory
- Compromised non-critical credential

Response SLA: 24 hours investigation start

### P3 (Low)
- Security awareness finding
- Policy deviation
- Non-critical system misconfiguration

Response SLA: 5 business days

## Detection Sources

Automated detection is monitored through:

1. AWS GuardDuty - tracks anomalous API calls and network activity
2. CloudTrail - logs all AWS account actions for audit
3. Application logs - authentication failures, anomalous database queries
4. Intrusion detection - network signature analysis
5. Endpoint monitoring - host-based indicators of compromise
6. Third-party alerts - vendor security notifications

## Initial Response (0-30 minutes)

### On-Call Escalation
- P0/P1 incidents trigger PagerDuty page to security on-call
- Incident Commander assigned within 15 minutes
- War room established (Slack channel: #incident-response)

### Immediate Actions
1. Document incident discovery timestamp and source
2. Preserve evidence (disable automated log rotation, snapshot systems)
3. Quarantine affected systems if necessary to prevent spread
4. Notify impacted users (GDPR Article 33 triggers at this stage for suspected breach)
5. Engage legal/compliance team for P0 incidents

### Initial Assessment
- Confirm incident authenticity (false positives happen)
- Determine scope: affected systems, data, users
- Establish containment strategy
- Assign investigation lead

## Investigation (30 minutes - 2 hours)

### Forensics
- Preserve logs and system state
- Identify root cause (human error, vulnerability, compromise)
- Determine when incident began and when it was discovered
- List all affected data elements

### Scope Expansion
- Check for lateral movement in network
- Audit database access logs for exfiltration
- Review all recent administrative access
- Query authentication_attempts table for brute-force patterns

### Containment
- P0: Block attacker access, reset compromised credentials
- P1: Isolate affected system if safe to do so
- Patch vulnerability on non-isolated systems

## Notification (Parallel Activity)

### Internal Notification
- Executive team (CEO, CFO for P0)
- Compliance officer
- Legal counsel

### Regulatory Notification
- P0 Data Breach: Notify relevant state AGs within 30-72 hours per breach law
  - California Civil Code 1798.82: 30 days
  - NY SHIELD Act: 30 days
  - Other states: 30-45 days
- GDPR Breach (EU residents): 72 hours to supervisory authority
- CCPA Breach (CA residents): as expeditiously as possible
- Payment Card Industry: within 24 hours if cardholder data involved

### Notification Content
- Incident date and discovery date
- Data affected (count of records, data types)
- Steps being taken to mitigate
- Contact for further inquiry

Notification templates are auto-populated with incident data from the security_incidents table.

## Containment Per Incident Type

### Data Breach
1. Stop active exfiltration (block attacker IPs, revoke sessions)
2. Restore database from clean backup if necessary
3. Reset all affected user credentials
4. Rotate encryption keys
5. Audit all data access for 90 days prior

### Ransomware
1. Isolate infected systems from network immediately
2. Restore from last known good backup
3. Scan all systems for secondary payloads
4. Rebuild servers from golden image

### On-Chain Exploit
1. Pause contract operations if possible
2. Assess if clawback is necessary
3. Notify affected importers immediately
4. Prepare compensation plan

### Credential Compromise
1. Revoke compromised credentials immediately
2. Reset related service credentials
3. Force password reset for affected users
4. Review all recent access with compromised credential

## Recovery (2 hours - ongoing)

### Restore Operations
- Bring systems back online in safe order
- Validate data integrity post-restore
- Monitor for re-compromise
- Implement temporary compensating controls

### Post-Incident Review
- Conduct timeline analysis (detection lag, response time)
- Root cause analysis (why this happened)
- Preventive actions (what changes prevent recurrence)
- Gap analysis (what detection/controls were missing)

## Post-Incident (Next 7-30 days)

### Mandatory Activities
- Tabletop exercise of the response (within 30 days)
- Preventive control implementation
- Customer communication (if trust repair needed)
- Insurance claim filing (if applicable)
- Regulatory follow-up (CCPA, GDPR, state AGs)

### Documentation
- Store incident report in docs/security/tabletop-exercises/
- Include: timeline, root cause, impact, response timeline, preventives
- Publish lessons learned to team

## Escalation Chain

```
Detection
    |
    v
PagerDuty Alert (P0/P1)
    |
    v
On-Call Security Engineer (0-15 min)
    |
    v
Incident Commander assigned
    |
    +-- Engineering Lead
    |
    +-- Database Administrator
    |
    +-- Compliance Officer
    |
    +-- Legal Counsel (P0 only)
    |
    v
CISO (P0/P1)
    |
    v
CEO/CFO (P0 only)
```

## Escalation Criteria for External Notification

**MUST notify regulators:**
- Any confirmed data breach
- Any GDPR-scoped incident affecting EU residents
- Any CCPA-scoped incident affecting California residents
- Ransomware with data exfiltration

**SHOULD notify customers:**
- P0 incidents affecting their accounts
- Any data exposure involving their data

**SHOULD notify law enforcement:**
- Ransomware with payment demand
- Incident with criminal elements (fraud, theft)

## Key Contacts

Maintain current contact list in 1Password (vault: Security):
- CISO: [name, phone, email]
- Legal counsel: [firm, attorney, phone]
- Compliance officer: [name, phone, email]
- AWS TAM: [name, phone]
- Cyber insurance broker: [name, phone]

## Annual Tabletop Exercise

Conduct a tabletop exercise at minimum annually, simulating a P0 incident:

1. Kick-off: Brief team on fictional incident scenario
2. Investigation: Team dials in, gathers information
3. Decision points: Discuss notification, containment, recovery
4. Hot wash: Debrief on gaps, improvements
5. Report: Document lessons learned

Store exercises in `docs/security/tabletop-exercises/YYYY-MM-DD-exercise-report.md`

## Monitoring and Alerting

Key alerting thresholds:

- 10+ failed auth attempts in 30 minutes: P1 brute-force alert
- Unusual database query patterns: P1 investigation
- Spike in API 401/403 responses: P1 investigation
- GuardDuty findings: P0-P2 depending on finding type
- CloudTrail root account activity: Immediate P0

## Training

All employees complete annual security training including incident response basics. Security team practices response quarterly.
