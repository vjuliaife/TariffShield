# Security scanning

TariffShield uses GitHub CodeQL to scan the JavaScript and TypeScript codebase for security and code-quality issues.

## CodeQL coverage

The CodeQL workflow runs for pull requests targeting `main`, on a weekly schedule at `03:00 UTC` every Monday, and on manual dispatch. It analyzes JavaScript and TypeScript with the `security-and-quality` query suite.

The scan covers the API, web app, SDK, and TypeScript scripts:

- `apps/api/src`
- `apps/web`
- `packages/sdk/src`
- `scripts`

Generated and build outputs are excluded through `.github/codeql/codeql-config.yml`, including `node_modules`, `dist`, `build`, `.next`, coverage output, and generated TypeScript files.

## Triage policy

CodeQL findings with `error` level or critical security severity are release blockers. The workflow reads the generated SARIF report after analysis and fails the pull request check when those blocking findings are present. Maintainers should also require the CodeQL check before merging protected branches and should fix or explicitly dismiss those alerts in GitHub code scanning before a pull request is merged.

Warning-level findings should be reviewed from the pull request annotations and the repository Security tab. They do not block merge by default, but they should be marked as fixed, false positive, or accepted risk during triage.

## Reviewing alerts

1. Open the repository Security tab.
2. Select Code scanning alerts.
3. Filter by tool `CodeQL` and sort by severity.
4. Assign each alert to the relevant owner.
5. Close the alert only after the fix is merged or after the maintainer records why the finding is not exploitable.

If a CodeQL alert identifies a credential exposure, authentication bypass, injection path, or unsafe cryptographic use, treat it as a security incident and follow `docs/security/incident-response-playbook.md`.
