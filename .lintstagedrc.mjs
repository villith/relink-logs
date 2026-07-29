/**
 * Pre-commit fixes, so formatting and lint never reach CI broken.
 *
 * The first two entries mirror what `.github/workflows/ci.yaml` checks —
 * `npm run format-check` (Prettier over everything under `src/`) and
 * `npm run lint` (ESLint over `./src`) — but with `--write`/`--fix`, and only
 * over staged files. lint-staged re-stages whatever they rewrite, so the fix
 * lands in the same commit rather than as a follow-up.
 *
 * `tsc` and Vitest are deliberately absent: both are whole-project, neither
 * can auto-fix, and running them per commit costs ~40s. They stay in CI.
 */
export default {
  // Prettier's own file-type support decides what it touches (--ignore-unknown
  // skips the rest), matching CI's `prettier --check ... src` rather than a
  // hand-maintained extension list that would drift from it.
  "src/**/*": ["prettier --write --ignore-unknown"],
  "src/**/*.{js,jsx,ts,tsx}": ["eslint --fix"],
  // A function, so lint-staged appends no filenames: `rustfmt` follows `mod`
  // declarations into child modules, so per-file runs would check far more
  // than the file named — `cargo fmt` over the workspace is the honest scope.
  // Check-only (unlike the JS entries): rustfmt rewrites whole files, and
  // silently restyling a reverse-engineered hook mid-commit is worse than
  // being told to run `cargo fmt` yourself.
  "*.rs": () => "cargo fmt --all -- --check",
};
