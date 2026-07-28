# PR Title
docs(repo): fix #289 Mermaid diagrams and fix #285 CI Rust format and clippy lints and fix #283 automated changelog and fix #288 deployment guide

# Commit Message
docs(repo): fix #289, #285, #283, and #288 documentation, CI, and changelog automation

# PR Description
This Pull Request resolves four separate issues in the codebase: #289, #285, #283, and #288.

1. **System Topology and Data Flow Diagrams (fix #289)**:
   Added three interactive, GitHub-compatible Mermaid diagrams to the system documentation. This helps onboarding contributors and technical stakeholders quickly visualize the system component boundaries, protocol connections, and execution sequences for:
   * **System Topology**: Highlighting browser dashboards, Next.js web client, Express API, PostgreSQL databases, SDK, and Soroban contract nodes (`graph TD`).
   * **Tariff Spike & Auto-Top-Up Flow**: Sequence of webhook invocation, database writing, SDK translation, Soroban execution, event emissions, and database mirroring.
   * **Surety Admin Clawback Flow**: Sequence of security role verification, balance draining, contract account freezing, and transaction result rendering.

2. **GitHub Actions Rust Formatting & Clippy Lints Gate (fix #285)**:
   Integrated strict Rust compilation rules to the PR lifecycle:
   * Added `rustfmt.toml` with default rules (`max_width = 100`, `edition = "2021"`).
   * Appended parallel linting jobs (`fmt` and `clippy` with `-D warnings` flag) to the GitHub Actions test workflow, utilizing Cargo build caches to reduce overhead.
   * Suggested pre-commit hooks configuration inside `CONTRIBUTING.md`.

3. **Automated Changelog Generation (fix #283)**:
   Configured automated versioning:
   * Installed `conventional-changelog-cli` into dependencies.
   * Added the `"changelog"` run script.
   * Bootstrapped the historical changelog records retroactively into `CHANGELOG.md`.

4. **Step-by-step System Deployment Guide (fix #288)**:
   Authored [docs/deployment.md](docs/deployment.md) covering:
   * Binary dependency versions (Node 20, Rust, CLI).
   * Complete API environment reference maps.
   * CLI optimization and deployment syntax for mainnet/testnet.
   * Render deployment context configuration and Vercel production hosting guidelines.
   * Smoke test queries and rollback actions.

# Changed
* **ARCHITECTURE.md** (fix #289): Replaced manual diagrams with three `graph TD` / `sequenceDiagram` Mermaid diagrams, with corresponding legend and introductory summaries.
* **.github/workflows/ci.yml** (fix #285): Appended `fmt` and `clippy` verification steps running in parallel with Cargo cache.
* **rustfmt.toml** (fix #285): Created formatting parameters.
* **CONTRIBUTING.md** (fix #285): Added hook suggestions.
* **package.json** (fix #283): Installed `conventional-changelog-cli` and registered `"changelog"` task script.
* **CHANGELOG.md** (fix #283): Generated initial release records.
* **docs/deployment.md** (fix #288): Wrote detailed deployment walkthrough guide.

# Testing
* Verified formatting checking tool locally:
  ```bash
  cargo fmt --all -- --check
  ```
* Ran code testing checks locally:
  ```bash
  npm run contract:test
  ```

# Scope Notes
* **Scope**: Documentation, Github CI workflows, and project packaging dependencies only.
* No changes were made to smart contract logic, backend Express logic, or Next.js components.

# Push Command
```bash
git push origin feature/resolved-issues
```
