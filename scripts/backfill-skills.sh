#!/usr/bin/env bash
# Regenerate en/ui.json skill placeholders from saved encounters.
#
# Scans src-tauri/logs.db for player skill IDs that have no name in
# src-tauri/lang/en/ui.json and stubs each missing one with a
# "Skill <id>" placeholder under its character block. Add-only and
# idempotent — existing names are never touched, so it is safe to rerun.
#
# Usage:
#   scripts/backfill-skills.sh                 # uses default db + ui paths
#   scripts/backfill-skills.sh --db <path> --ui <path>
#
# Any args are forwarded to the underlying example binary.
set -euo pipefail

# Run from the repo root regardless of where the script is invoked.
cd "$(dirname "$0")/.."

cargo run -p gbfr-logs --example skill_backfill -- "$@"
