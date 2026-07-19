# Translation Contributions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let non-technical users (GitHub account only) submit translation fixes via GitHub issue forms, and surface GitHub / Bugs / Translate buttons in the Logs window header.

**Architecture:** Two GitHub issue-form templates (`.github/ISSUE_TEMPLATE/`) collect structured reports; the maintainer applies fixes to `src-tauri/lang/<lang>/ui.json` by hand. The Logs window header (`src/pages/Logs.tsx`) gains three right-aligned buttons that open the repo / issue forms in the system browser via Tauri's `shell.open` (already allowlisted). Button labels are new i18n keys in `en/ui.json`.

**Tech Stack:** GitHub issue forms (YAML), React + Mantine v7, `@phosphor-icons/react`, `@tauri-apps/api/shell`, i18next.

**Spec:** `docs/superpowers/specs/2026-07-18-translation-contributions-design.md`

**Branch:** work directly on the current `fix/xpac` branch (matches where in-flight work lives). Commit only the files named in each task — the working tree contains unrelated modified files; never use `git add -A`.

**Testing note:** the repo has no React component test infrastructure (vitest covers `src/utils.ts` only) and issue-form YAML is only truly validated by GitHub itself. Tasks therefore use: YAML parse check locally, `npm run build` (tsc typecheck), `npm run lint`, `npx vitest run` (regression), and a manual visual check via `npm run dev`. Do NOT add component-test infrastructure for this feature (YAGNI).

---

### Task 1: GitHub issue form templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/translation.yml`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`

`.github/` already exists (contains `workflows/`); `ISSUE_TEMPLATE/` does not — create it.

- [ ] **Step 1: Create `.github/ISSUE_TEMPLATE/translation.yml`**

```yaml
name: Translation fix / new language
description: Report a wrong or missing translation, or request a new language. No coding knowledge needed.
title: "[Translation]: "
labels: ["translation"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for helping improve GBFR Logs translations!

        **Note:** item / weapon / skill **names** come directly from the game's own data files and cannot be hand-edited. Only the app's own interface text (buttons, labels, settings, messages) can be changed here.
  - type: dropdown
    id: language
    attributes:
      label: Language
      options:
        - English (en)
        - 简体中文 (zh-CN)
        - 繁體中文 (zh-TW)
        - 한국어 (ko-KR)
        - 日本語 (jp)
        - Français (fr-FR)
        - Português brasileiro (bp)
        - Deutsch (ge)
        - Español (es-ES)
        - Italiano (it-IT)
        - Other / new language
    validations:
      required: true
  - type: dropdown
    id: change-type
    attributes:
      label: Type of change
      options:
        - Wrong translation
        - Typo
        - Text shows in English (untranslated)
        - Request a new language
    validations:
      required: true
  - type: textarea
    id: location
    attributes:
      label: Where does the text appear?
      description: Which window / screen / button? You can paste a screenshot directly into this box.
    validations:
      required: true
  - type: input
    id: current-text
    attributes:
      label: Current text
      description: The text exactly as the app shows it now. Leave empty for new-language requests.
  - type: input
    id: suggested-text
    attributes:
      label: Suggested text
      description: What it should say instead. Leave empty for new-language requests.
  - type: textarea
    id: notes
    attributes:
      label: More fixes or notes (optional)
      description: "You can batch several fixes in one issue — one per line, e.g.: `current text → suggested text`"
```

- [ ] **Step 2: Create `.github/ISSUE_TEMPLATE/bug.yml`**

```yaml
name: Bug report
description: Something broken or not working?
title: "[Bug]: "
labels: ["bug"]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: Also tell us what you expected to happen. You can paste screenshots directly into this box.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. Start the game, then GBFR Logs
        2. ...
  - type: input
    id: app-version
    attributes:
      label: GBFR Logs version
      description: Shown in the title bar of the meter window.
    validations:
      required: true
  - type: input
    id: game-version
    attributes:
      label: Game version
  - type: textarea
    id: log-file
    attributes:
      label: Log file (optional)
      description: If the app crashed or misbehaved, drag & drop the log file here. It lives at `%APPDATA%\gbfr-logs\gbfr-logs.txt`.
```

- [ ] **Step 3: Validate both YAML files parse**

Run (from repo root):

```bash
npx --yes js-yaml .github/ISSUE_TEMPLATE/translation.yml > /dev/null && npx --yes js-yaml .github/ISSUE_TEMPLATE/bug.yml > /dev/null && echo YAML-OK
```

Expected: `YAML-OK` (js-yaml exits non-zero and prints the error location on a syntax error).

- [ ] **Step 4: Commit**

```bash
git add .github/ISSUE_TEMPLATE/translation.yml .github/ISSUE_TEMPLATE/bug.yml
git commit -m "feat: add translation and bug-report issue forms"
```

---

### Task 2: i18n keys for the header buttons

**Files:**
- Modify: `src-tauri/lang/en/ui.json` (the `"ui"` object, near the top with the other short labels)

`ui.json` is the ONLY hand-editable lang file (all others are autogenerated). Keys live nested under the top-level `"ui"` object and are referenced as `t("ui.<key>")`.

- [ ] **Step 1: Add three keys to the `"ui"` object in `src-tauri/lang/en/ui.json`**

Insert after the existing `"settings"` entry (line ~15):

```json
    "settings": "Settings",
    "github": "GitHub",
    "report-bug": "Report a Bug",
    "help-translate": "Help Translate",
```

- [ ] **Step 2: Validate JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('src-tauri/lang/en/ui.json','utf8')); console.log('JSON-OK')"
```

Expected: `JSON-OK`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/lang/en/ui.json
git commit -m "feat: add i18n keys for header link buttons"
```

---

### Task 3: Header buttons in the Logs window

**Files:**
- Modify: `src/pages/Logs.tsx`

The header is an `AppShell.Header` containing a single `Group` (burgers + "GBFR Logs" title). Restructure it into a space-between layout with a right-aligned button group. External URLs open via `open` from `@tauri-apps/api/shell` — same pattern as `src/utils.ts:283`; `shell.open` is already allowlisted in `tauri.conf.json`.

- [ ] **Step 1: Update imports in `src/pages/Logs.tsx`**

Replace:

```tsx
import { AppShell, Burger, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Flag, Gear, House } from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
```

with:

```tsx
import { AppShell, Burger, Button, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Bug, Flag, Gear, GithubLogo, House, Translate } from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/shell";
```

and add below the react-router import:

```tsx
import { useTranslation } from "react-i18next";
```

- [ ] **Step 2: Add the repo URL constant and `t`**

Directly above `const Layout = () => {`:

```tsx
const GITHUB_URL = "https://github.com/villith/gbfr-logs";
```

Inside `Layout`, next to the other hooks (after the `useMeterSettingsStore` line):

```tsx
const { t } = useTranslation();
```

- [ ] **Step 3: Restructure the header**

Replace:

```tsx
        <AppShell.Header>
          <Group h="100%" px="sm">
            <Burger opened={mobileOpened} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
            <Burger opened={desktopOpened} onClick={toggleDesktop} visibleFrom="sm" size="sm" />
            <Text>GBFR Logs</Text>
          </Group>
        </AppShell.Header>
```

with:

```tsx
        <AppShell.Header>
          <Group h="100%" px="sm" justify="space-between">
            <Group h="100%" gap="sm">
              <Burger opened={mobileOpened} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
              <Burger opened={desktopOpened} onClick={toggleDesktop} visibleFrom="sm" size="sm" />
              <Text>GBFR Logs</Text>
            </Group>
            <Group gap="xs">
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<GithubLogo size="1rem" />}
                onClick={() => open(GITHUB_URL)}
              >
                {t("ui.github")}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<Bug size="1rem" />}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=bug.yml`)}
              >
                {t("ui.report-bug")}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<Translate size="1rem" />}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=translation.yml`)}
              >
                {t("ui.help-translate")}
              </Button>
            </Group>
          </Group>
        </AppShell.Header>
```

- [ ] **Step 4: Typecheck, lint, and run the existing test suite**

```bash
npm run build
npm run lint
npx vitest run
```

Expected: all three pass (build = tsc + vite; no new lint errors; existing utils tests unchanged). Do NOT use `npm run test` (watch mode, never exits).

- [ ] **Step 5: Manual visual check**

Run `npm run dev` (frontend only; no game needed), open the printed localhost URL in a browser, navigate to `/logs`. Expected: three subtle buttons (GitHub / Report a Bug / Help Translate) right-aligned in the header row, title still on the left. Clicking will error in a plain browser (no Tauri shell) — that's fine; the layout is what's being checked. Ctrl-C when done.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Logs.tsx
git commit -m "feat: add GitHub, bug-report, and translate buttons to logs header"
```

---

### Task 4: Documentation pointers

**Files:**
- Modify: `README.md` (insert new section before `## Frequently Asked Questions`, line ~52)
- Modify: `src-tauri/lang/README.md` (append)

- [ ] **Step 1: Add a contributing section to `README.md`**

Insert immediately before the `## Frequently Asked Questions` heading:

```markdown
## Found a translation problem or a bug?

You don't need any coding knowledge to help — just a GitHub account:

- [Report a wrong or missing translation](https://github.com/villith/gbfr-logs/issues/new?template=translation.yml) — fill in the form and we'll apply the fix.
- [Report a bug](https://github.com/villith/gbfr-logs/issues/new?template=bug.yml)

Note: item / weapon / skill names come from the game's own data files and can't be hand-edited — only the app's interface text can be changed.

```

- [ ] **Step 2: Update `src-tauri/lang/README.md`**

Append to the end of the file:

```markdown

## Not comfortable editing files?

Open a [translation issue](https://github.com/villith/gbfr-logs/issues/new?template=translation.yml) instead — fill in the form (language, current text, suggested text) and a maintainer will apply the change to `ui.json` for you.
```

- [ ] **Step 3: Commit**

```bash
git add README.md src-tauri/lang/README.md
git commit -m "docs: point contributors at the translation and bug issue forms"
```

---

### Task 5: Create the GitHub labels

The issue forms declare `labels: ["translation"]` / `["bug"]`. GitHub silently drops labels that don't exist in the repo, so ensure both exist on `villith/gbfr-logs` (the release fork the buttons point at — NOT the `false-spring` upstream, so always pass `-R`).

- [ ] **Step 1: Check which labels already exist**

```bash
gh label list -R villith/gbfr-logs
```

Expected: default GitHub labels including `bug`; `translation` almost certainly absent.

- [ ] **Step 2: Create the `translation` label (skip if it exists)**

```bash
gh label create translation -R villith/gbfr-logs --color 0E8A16 --description "Translation fixes and new-language requests"
```

Expected: `✓ Label "translation" created in villith/gbfr-logs`. If Step 1 showed `bug` missing too: `gh label create bug -R villith/gbfr-logs --color d73a4a --description "Something isn't working"`.

No commit — this is repo configuration, not code.

---

### Done criteria

- Both issue forms parse and are committed (they take effect once the branch is pushed/merged to the repo's default branch).
- Logs header shows the three buttons; `npm run build`, `npm run lint`, `npx vitest run` all pass.
- README + lang README link to the forms.
- `translation` (and `bug`) labels exist on `villith/gbfr-logs`.
