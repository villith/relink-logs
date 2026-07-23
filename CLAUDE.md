# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Relink Logs (formerly GBFR Logs; built upon the now-unmaintained [false-spring/gbfr-logs](https://github.com/false-spring/gbfr-logs), no longer affiliated with it) is a DPS parser/overlay for Granblue Fantasy: Relink. It works by DLL-injecting a hook into the running game process, reading game memory + hooking damage functions, and broadcasting events over a named pipe to a Tauri desktop app that parses and displays them. Windows-only; requires running as admin against a live game process.

## Development commands

Requires **nightly Rust** ([rustup.rs](https://rustup.rs/)) + Node.js.

```sh
npm install
npm run tauri dev      # full app: builds hook.dll (release), runs Tauri backend + Vite frontend
```

- `npm run dev` — builds the hook DLL with the `console` feature, then runs Vite (frontend only).
- `npm run build` — `tsc` typecheck + Vite production build of the frontend.
- `npm run test` — Vitest (frontend unit tests). Single file: `npx vitest run src/utils.test.ts`. Watch: `npx vitest`.
- `npm run lint` — ESLint over `./src`.
- `npm run format` / `npm run format-check` — Prettier.
- Rust: `cargo build` / `cargo test` / `cargo clippy` at the workspace root, or `-p gbfr-logs` / `-p hook` / `-p protocol` for a single crate.

There is no Rust-side automated test suite of note; verify backend changes by running the app against the game.

## Architecture: five subprojects, two languages

Data flows **game → hook → pipe → parser → frontend**:

1. **`src-hook/`** (crate `hook`, builds `hook.dll`) — Injected into `granblue_fantasy_relink.exe`. Sets up function hooks (`src/hooks/`: damage, death, player load, quest/area, SBA) that read game memory via raw pointers and vtable offsets. Broadcasts `protocol::Message` events over the named pipe `\\.\pipe\gbfr-logs`. Entry is a `#[ctor]` that spawns the server. **The memory offsets and actor-type hashes here (e.g. `get_source_parent` in `hooks/mod.rs`) are reverse-engineered and break on game patches.** The hook also serves the Toolbox RPC channel (see game-reader below).

2. **`protocol/`** (crate `protocol`) — Shared message types (`Message` enum, `DamageEvent`, `PlayerLoadEvent`, etc.). Wire format between hook and parser is **bincode**, so the hook and parser must be compiled together. Read the crate-level doc comment in `src/lib.rs` before changing any message type — adding fields/variants is safe, but the parser's own on-disk format is separate and must stay backward-compatible. The toolbox module carries the request/response channel for the Toolbox tools (`\\.\pipe\gbfr-logs-toolbox` on Windows, TCP 127.0.0.1:39372 under Wine; one request per connection; `TOOLBOX_PROTOCOL_VERSION` guards hook/app skew).

3. **`game-reader/`** (crate `game-reader`) — Platform-independent snapshot
   walkers plus the RE'd signatures/offsets behind the Toolbox tools
   (synthesis, overmastery), generic over a `MemRead` trait and unit-tested
   against fake memory. Production path: the hook reads in-process (guarded)
   and serves results over the toolbox RPC channel — on both OSes. The diag
   examples (`om_probe`, `synth_probe`, `synth_diag`, `toolbox_probe`) read
   the same structures via `ReadProcessMemory` (`src-tauri/src/game_mem.rs`,
   Windows-only, admin) as an independent cross-check. A game patch that
   moves these structures is fixed in this crate.

4. **`src-tauri/`** (crate `gbfr-logs`, the main binary) — The Tauri backend.
   - `src/main.rs` — Tauri setup, `#[tauri::command]` handlers (the frontend's API surface: `fetch_logs`, `fetch_encounter_state`, `delete_logs`, etc.), system-tray menu, the two app windows, and `check_and_perform_hook` (polls for the game process, injects the DLL, then reads the pipe and feeds events into the parser). If `hook-dbg.dll` exists next to the binary, it's injected instead of `hook.dll`.
   - `src/parser/` — Versioned parsing. `deserialize_version` in `mod.rs` dispatches by stored version byte; `v0` is legacy and upgrades into `v1`. The `v1::Parser` holds an `Encounter` (raw event log, the source of truth) and a `DerivedEncounterState` (computed party/DPS/stun, what the frontend consumes). Logs are re-parsed from the raw event log, so DerivedEncounterState can change between app versions without losing data. Live encounter state is pushed to the frontend via Tauri events (`encounter-update`, `encounter-saved`, `on-area-enter`, `encounter-party-update`, etc.).
   - `src/db/` — SQLite (`logs.db`, WAL mode) via rusqlite. Encounters are stored zstd-compressed in the `data` BLOB with a `version` column. **Schema changes are append-only migrations** in `db/mod.rs` (`Migrations`/`M::up`) — never edit an existing migration.

5. **`src/`** — React + TypeScript frontend (Vite, Mantine UI, Zustand stores, react-router, i18next). Two windows defined in `src-tauri/tauri.conf.json`: `main` (the transparent, always-on-top overlay → `Meter`) and `logs` (history/charts/settings). Pages live in `src/pages/`; each page has a companion `useX` hook holding its logic. Backend calls go through `@tauri-apps/api` `invoke`; live data arrives via `listen(...)` (see `src/pages/useMeter.ts`). `src/types.ts` mirrors the Rust serde types (camelCase) — keep them in sync when changing backend response shapes.

## Conventions and gotchas

- **Do NOT use git worktrees** in this repo — create branches in the main checkout instead. (Windows file locks make worktree directories fail to clean up, and shells/monitors holding a worktree cwd keep it busy.)
- **Do NOT commit specs or plans.** `docs/superpowers/specs/` and `docs/superpowers/plans/` are local working notes and are gitignored — never `git add` them or otherwise track them.
- **Localization:** only hand-edit `src-tauri/lang/<lang>/ui.json`. The other lang files and `src-tauri/assets/skill-groups.json` are autogenerated and overwritten on game updates. Missing translations fall back to `en`.
- **All user-facing strings must go through i18next** — `t("ui.…")` with the key added to `src-tauri/lang/en/ui.json` (other languages fall back to `en`, so English-only keys are fine). This is enforced by `eslint-plugin-i18next` (`i18next/no-literal-string`) in `npm run lint`; `*.test.ts(x)` files are exempt. The rule only checks JSX *text*, so user-facing strings in props/attributes (`aria-label`, `placeholder`, `title`, tooltip `label`, toast messages) are NOT caught — translate those anyway. For intentional non-translatables (the "Relink Logs" brand name, bare glyphs like ✓), add a targeted `eslint-disable-next-line i18next/no-literal-string -- <reason>` rather than weakening the rule config (the plugin shallow-merges options, so overriding `words`/`jsx-attributes` silently drops its built-in excludes).
- **Versions** are managed by CI — do not hand-bump them. They live in five files that must always agree (`package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock`); `scripts/set-version.mjs` writes all five and is the only thing that should. Every push to `dev` auto-bumps to the next RC (`X.Y.Z-N`) and publishes a signed *prerelease*; a stable release is the "Run workflow" button, which strips the suffix and then fast-forwards `main`. To choose a minor/major base for the next release, run `npm run bump -- minor` (or an explicit `X.Y.Z`) in a PR. The updater endpoint is `latest.json`, built by the release workflow and published at `releases/latest/download/latest.json`; there is no `update.json` in the repo any more.
- **Stable releases require a `CHANGELOG.md` section.** `.github/workflows/release.yaml` runs `scripts/extract-changelog.mjs <version>` *before* committing anything and fails the dispatch when the version has no `## <version>` section. The section body becomes the GitHub release body and is copied into `latest.json` as the updater notes rendered by `src/components/UpdateNotes.tsx`. RC prereleases skip this gate and fall back to placeholder notes. Changelog entries are written by humans, not generated.
- **Adding a tracked event end-to-end** touches all four projects: add a hook in `src-hook/src/hooks/`, a `Message` variant in `protocol/`, a handler in `connect_and_run_parser` (`main.rs`) + parser logic in `parser/v1/`, and frontend display in `src/`.
- The app keeps running in the system tray after windows close; closing a window hides it rather than exiting (`on_window_event` in `main.rs`).
- **Dev hook hot-reload:** with the game and a debug app running, rebuild the
  hook (`cargo build --release -p hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject`)
  and click tray → "Reload hook (dev)". The app tells the hook to tear itself
  down over a dedicated dev control channel (`protocol::control`, separate from
  the toolbox RPC), ejects the old DLL, refreshes `hook-dbg.dll` from
  `target/release/hook.dll`, and re-injects — no game or app restart. Dev-only:
  a release hook has no control channel (feature `eject`), so the reload just
  reports a connection error.
- **Linux (Proton) build:** the game has no Linux version; Linux support runs
  the same Windows exe under Proton, so all RE'd signatures/offsets are shared.
  The hook doubles as a `dinput8.dll` proxy (`src-hook/src/proxy.rs`) and
  serves events over localhost TCP (`protocol::TCP_ADDR`) when it detects
  Wine; the app deploys it via `src-tauri/src/linux_support/`. The hook crate
  itself only compiles on Windows — Linux CI (`cargo_check_linux` in ci.yaml)
  builds `-p gbfr-logs` with `--lib --bins` (the examples are Windows diag
  tools; don't "fix" them to build on Linux). `npm run dev` on a non-Windows
  host skips the hook build; drop a CI-built `hook.dll` into `src-tauri/` for
  live-game work there. The `libayatana-appindicator3-1` entry in
  tauri.conf.json's `deb.depends` is intentionally duplicated — the CLI
  auto-adds it, but the explicit entry documents the tray dependency.
