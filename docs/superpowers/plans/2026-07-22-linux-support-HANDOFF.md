# Linux Support — Session Handoff (2026-07-22)

Work paused mid-plan at the user's request. This doc captures exact state so
the next session can resume without re-derivation.

## Where everything lives

- **Worktree:** `.worktrees/linux-support` (gitignored), branch **`feat/linux-support`**, currently at `800110e`. All implementation commits are here.
- **Main checkout:** on branch `spec/linux-support` (spec + plan + .gitignore commits only; `feat/linux-support` branched off it).
- **Spec:** `docs/superpowers/specs/2026-07-22-linux-support-design.md`
- **Plan:** `docs/superpowers/plans/2026-07-22-linux-support.md` (15 tasks)
- **Nothing has been pushed anywhere.** No PR exists. The only remote is named **`fork`** (`git@github.com:villith/gbfr-logs.git`) — there is NO `origin`; any push commands must use `fork`. (The GitHub repo has since been renamed relink-logs; the old URL redirects.)

## Task status (subagent-driven: every done task passed spec review + code-quality review, with fixes re-reviewed)

| # | Task | Status | Commits |
|---|---|---|---|
| 1 | Protocol TCP constants (`TCP_ADDR` 127.0.0.1:39371) | ✅ done | `6a45ac3` |
| 2 | Hook Wine detection + transport selection (`src-hook/src/transport.rs`, `GBFR_LOGS_FORCE_TCP=1` override) | ✅ done | `43d7e82` |
| 3 | Hook TCP listener (`run_pipe`/`run_tcp` split, generic `handle_client`) | ✅ done | `3845edb`, fix `616b441` |
| 4 | dinput8 proxy export + `scripts/dump-exports.py` (export + "Relink Logs" marker verified in built DLL) | ✅ done | `a783a94`, fixes `b21f361`, `9600087` |
| 5 | src-tauri platform gating (target-scoped deps, cfg'd modules, command stubs, `connect_event_stream`) | ✅ done | `3587632` |
| 6 | `linux_support::steam` discovery (VDF parse, appid 881020, 10 tests) | ✅ done | `15b59e1` |
| 7 | `linux_support::deploy` (atomic temp+rename deploy, foreign-DLL protection, marker guard, 5 tests) | ✅ done | `b1d3293`, fix `e604925` |
| 8 | Linux glue in main.rs (deploy-and-connect, setup commands, GDK_BACKEND=x11, de-panicked toggles) | ✅ done | `698ec3a`, fix `525c2ae` |
| 9 | tauri `os` allowlist + `os-all` feature + deb depends | ✅ done | `d8a479f` |
| 10 | Frontend platform detection + Toolbox gating | ✅ done | `6955d4c`, rework `50eee7a` |
| 11 | Linux setup panel in Settings (+15 en strings, cache test) | ✅ done | `51a784d` |
| 12 | Dev-script guard (`scripts/build-hook-dev.mjs`) | ✅ done | `f5c2610` |
| 13 | Linux CI job | ⚠️ **half done** | `800110e` (see below) |
| 14 | Release workflow split (build-hook / build-windows / build-linux / publish) | ❌ not started | — |
| 15 | Docs (README, CLAUDE.md) + validation checklists | ❌ not started | — |

Also on the branch: `4cdfb18` (package-lock version-field sync), `47a7440` (ignore .worktrees, on the spec branch).

## Task 13 — exactly where it stopped

The `cargo_check_linux` job was added to `.github/workflows/ci.yaml` and committed (`800110e`), **but CI has never run** — the implementer agent was stopped before pushing. Remaining steps:

1. `git push -u fork feat/linux-support` (NOT origin — it doesn't exist).
2. Open a **draft** PR targeting `dev` (ci.yaml only triggers on `pull_request` and pushes to `main`, so without a PR nothing runs). Never push to `dev`/`main` directly — a `dev` push triggers a signed RC release.
3. Watch the `Rust - Linux check` job. **This is the first time any of the branch's Linux cfg code compiles** — expect to iterate on compile errors (missed cfg imports, unused warnings on the not-windows side, tauri Linux API differences). Fix, verify Windows still green locally (`cargo test -p gbfr-logs` → 123; `npx vitest run` → 183), commit, push, re-watch until green.

## Local verification state (all green on Windows at `800110e`)

- `cargo test -p gbfr-logs` — 123 (incl. 15 linux_support), `cargo test -p hook` — 35, `cargo test -p protocol` — 1.
- `npx vitest run` — 183 across 20 files.
- `cargo build -p gbfr-logs` / `cargo build --release -p hook` — clean; clippy delta vs. pre-branch: zero.
- hook.dll verified: exports `DirectInput8Create`, VersionInfo CompanyName = "Relink Logs" (deploy.rs's foreign-DLL detection depends on this marker).

## Gotchas discovered this session (do not re-derive)

- **Remote name:** `fork`, not `origin` (see above).
- **Worktree eslint is broken by environment, not code:** ESLint resolves `@typescript-eslint` from both the worktree's and the parent repo's `node_modules` → "Could not find name uniquely". Pre-existing; CI's eslint job (clean checkout) is unaffected. Don't chase it.
- **Fresh worktrees need the hook built first:** bare `cargo test` fails (tauri resource `hook.dll` missing) until `cargo build --release -p hook` has run once (per the building-gbfr-logs skill; CI order matches).
- **`cargo test -p gbfr-logs` (bare) would fail on Linux** — three examples import cfg(windows) modules. Deliberate plan decision: Linux CI uses `--lib --bins` and examples stay Windows-only (documented in Task 15's CLAUDE.md text). Don't "fix" the examples.
- **`npm install` rewrites package-lock's version field** (release CI bumps version files but not the lockfile) — already committed as `4cdfb18`; `npm ci` avoids this.
- **dev branch has tauri 1.8.3 / cli 1.6.3** (release-signing work); this branch resolves tauri 1.6.1. Merge into dev will need a routine lockfile re-resolve — reviewer confirmed `os-all` and deb-depends behavior are unchanged in that train.

## Notes for the remaining tasks

- **Task 14** (release.yaml split): full YAML is in the plan. Key subtleties already encoded there: signed hook.dll must be mirrored to BOTH `src-tauri/hook.dll` and `target/release/hook.dll` (rust-cache could restore a stale unsigned one that build.rs would copy over the signed one); linux job sets `TAURI_PRIVATE_KEY`/`TAURI_KEY_PASSWORD`/`TAURI_TRAY=ayatana`; `promote` job's needs changes to `[version, publish]`. The `scripts/make-latest-json.mjs` source is in the plan.
- **Task 15** (docs): plan has the README/CLAUDE.md text. Additions promised during reviews: (a) one sentence in the spec/README acknowledging localhost-TCP has no peer auth (vs. the pipe's ACLs) — low severity, worst case fake local events; (b) Ubuntu 24.04 ships only webkit2gtk-4.1, so the Tauri v1 deb/AppImage story there is a known limitation worth a line; (c) the deb tray dependency is intentionally duplicated (CLI auto-adds it; explicit entry kept as documentation).
- **Review-suggested polish, all optional, none blocking:** busy-state on the setup panel's buttons (+ extract `useLinuxSetup` hook if done); `platform.ts` cache-of-rejected-promise note; bind-retry log backoff in `run_tcp`; pipe-path silent bind failure could gain a `warn!`; comment in `platform.test.ts` that the cache test depends on `clearMocks` staying off.
- **Validation gates (after Task 15):** Windows TCP soak via `GBFR_LOGS_FORCE_TCP=1` (procedure in plan Task 15 step 4 — needs the game, run with the user), then the 9-item live-Proton checklist (needs a real Linux machine with Steam + game; clickthrough and the ayatana tray assumption are verified there).
- **CHANGELOG.md is the user's** — never write it; a section is required before any stable release ships this.

## Resume recipe

Continue subagent-driven execution (superpowers:subagent-driven-development) against the plan: finish Task 13's push/PR/iterate loop (mind the `fork` remote), then Tasks 14 and 15, then the plan's final-review + finishing-a-development-branch flow. The draft PR body should say it exists to exercise CI and must not be merged until validation gates pass.
