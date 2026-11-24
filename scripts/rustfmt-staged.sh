#!/bin/sh
# Fail the commit if any staged .rs file isn't rustfmt-clean (uses the repo's rustfmt.toml).
# No-ops instantly when no Rust files are staged, so TypeScript-only commits stay fast.
# Usage: scripts/rustfmt-staged.sh [file.rs ...]   (lint-staged passes the staged files)

[ "$#" -eq 0 ] && exit 0

if ! command -v rustfmt >/dev/null 2>&1; then
  echo "rustfmt not found; install it with: rustup component add rustfmt" >&2
  exit 1
fi

if ! rustfmt --edition 2021 --config-path rustfmt.toml --check "$@"; then
  echo >&2
  echo "Staged Rust files are not rustfmt-clean. Run: cargo fmt --all   then re-stage." >&2
  exit 1
fi
