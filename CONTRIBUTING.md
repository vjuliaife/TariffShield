# Contributing to TariffShield

## Development Setup

See [README.md](README.md) for full environment setup instructions (Docker Compose, Stellar testnet, PostgreSQL, and contract deployment steps).

Quick start:

```bash
npm install
cp .env.example .env   # fill in required secrets
npm run seed           # seed local database
npm run dev:api        # start Express API on :3001
npm run dev:web        # start Next.js dashboard on :3000
```

---

## Pull Request Process

All PRs must target the `main` branch. When you open a PR, GitHub will pre-populate the body from [`.github/pull_request_template.md`](.github/pull_request_template.md). Fill in each section:

| Section | Purpose |
|---------|---------|
| **Summary** | One paragraph explaining what changed and why. Focus on the motivation, not just what the code does. |
| **Type of Change** | Tick the appropriate boxes so reviewers understand the scope at a glance. Tick **Breaking change** if existing callers need to update. |
| **Checklist** | Work through each item before requesting review. If an item does not apply, tick it and add a brief note explaining why. |
| **Related Issues** | Use `Closes #<number>` to auto-close issues on merge. Multiple issues: `Closes #123, closes #456`. |
| **Screenshots / Demo** | Required for any PR that changes the Next.js UI. A Loom recording is fine for complex flows. |
| **Deployment Notes** | List every action required after merge: new env vars, database migrations, contract upgrades, or Render/Vercel manual steps. Leave blank if none. |

### Review expectations

- At least one approving review is required before merge (enforced by branch protection).
- The CI suite (type-check, lint, contract tests, audit) must pass.
- Keep PRs focused — one feature or fix per PR. Large refactors should be discussed in an issue first.

---

## Conventional Commits

TariffShield uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message on a PR targeting `main` is validated by the `commitlint` CI job and must follow this format:

```
<type>(<scope>): <short description>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature visible to users or API consumers |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no behaviour change |
| `test` | Adding or updating tests |
| `ci` | Changes to GitHub Actions workflows or CI config |
| `chore` | Maintenance tasks — dependency bumps, tooling config |
| `perf` | Performance improvement |
| `revert` | Reverts a prior commit |

### Scopes

Use one of these scopes when the change is specific to a subsystem:

| Scope | Subsystem |
|-------|-----------|
| `contract` | Soroban smart contract (`contracts/tariff-shield/`) |
| `api` | Express API (`apps/api/`) |
| `web` | Next.js dashboard (`apps/web/`) |
| `sdk` | TypeScript SDK (`packages/sdk/`) |
| `ci` | GitHub Actions workflows |
| `docs` | Documentation in `docs/` |
| `deps` | Dependency version updates |

Omit the scope when the change spans multiple subsystems.

### TariffShield-specific examples

```
feat(contract): add penalty accrual for undercollateralised accounts
fix(api): handle missing EIN in bond validation response
docs(runbooks): add support escalation guide
ci: add commitlint workflow for PR commit validation
chore(deps): bump @stellar/stellar-sdk to v15.1.0
refactor(api): extract AML screening into dedicated service module
test(contract): add dispute resolution edge-case tests
feat(web): show collateral staleness warning on dashboard
fix(sdk): correct stroop-to-XLM conversion in depositCollateral helper
```

### Breaking changes

If a commit introduces a breaking API or contract change, add a `BREAKING CHANGE:` footer:

```
feat(contract): rename deposit_reserve to fund_reserve

BREAKING CHANGE: The Soroban entry point `deposit_reserve` has been renamed
to `fund_reserve`. SDK callers must update to `contractClient.fundReserve()`.
Migration: redeploy the contract and update the SDK package version.
```

A `BREAKING CHANGE` footer triggers a **major** version bump in the automated release.

---

## Versioning

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on every push to `main` (after CI passes). The version bump is determined by the highest-impact commit type since the last release:

| Commit type | Version bump |
|-------------|-------------|
| `fix`, `perf`, `refactor` | Patch (`0.1.x`) |
| `feat` | Minor (`0.x.0`) |
| `BREAKING CHANGE` footer | Major (`x.0.0`) |

`chore`, `docs`, `ci`, and `test` commits do not trigger a release. `semantic-release` writes the updated version to `package.json` (root and workspaces), appends an entry to [`CHANGELOG.md`](CHANGELOG.md), and creates a GitHub Release with generated release notes.
