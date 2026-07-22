# Handoff: Authenticode signing for releases

**Status as of 2026-07-22 (late night):** Azure is fully provisioned; the deploy key,
`RELEASE_DEPLOY_KEY` secret, and both branch rulesets are configured (done by the user —
the agent is permission-blocked from credential/ruleset changes). The pipeline is committed
on the `dev` branch (through `ee93505` on `villith/relink-logs`), which is the repo's
**default branch** and the permanent RC channel with **CI-managed versions** — see §4.
PR #16 was retargeted to dev. The pipeline is **single-pass via Tauri 1.7+ `signCommand`**
(see §1 — the two-pass design was proven unfixable and deleted). **The pipeline is GREEN
end-to-end: run 29941357735 (dev @ `5160023`) published prerelease `1.11.2-1`** — exe, MSI,
and hook.dll Authenticode-signed, bundler-built updater zip minisigned, hand-built
latest.json uploaded, tag created atomically, `releases/latest` still serving 1.11.1
(the RC is invisible to installed apps). One gotcha encoded in `ci-sign.ps1`: it must run
under **pwsh**, not Windows PowerShell — the TrustedSigning module lives in PS7 module
paths (first attempt failed as `failed to run powershell`).

---

## 1. Why the workflow changed (read this before touching it)

The release job no longer uses `tauri-apps/tauri-action`. Do not put it back without
understanding the constraint that removed it.

Releases carry **two independent signatures**:

| Signature | Produced by | Verified by | Covers |
|---|---|---|---|
| minisign | `TAURI_PRIVATE_KEY` | the in-app updater | bytes of the updater `.msi.zip` |
| Authenticode | Azure Artifact Signing | Windows, SmartScreen, UAC, AV | the exe, `hook.dll`, the MSI |

**Authenticode must be applied first.** minisign signs the *bytes* of the updater artifact,
and Authenticode rewrites those bytes. Sign in the wrong order and the published `.sig` no
longer matches the published artifact, so every existing install fails signature verification
and cannot auto-update. Users would have to reinstall by hand.

`tauri-action` bundles and minisigns in one step and exposes no hook between them, and
Tauri ≤1.6 drove signtool only through `bundle.windows.certificateThumbprint` (a
machine-store cert, which Artifact Signing's short-lived dlib-issued certs cannot satisfy).
The fix is **`bundle.windows.signCommand`, backported from Tauri 2 in the Tauri 1.7
release train** (npm CLI ≥ 1.6.0; this repo now pins cli 1.6.3 / tauri 1.8.3 /
tauri-build 1.5.6). The bundler invokes `scripts/ci-sign.ps1` (`Invoke-TrustedSigning`,
`%1` = file) for the exe and the MSI at the right points in its own sequence, then zips the
SIGNED MSI and minisigns it — the ordering constraint is enforced inside one
`tauri build -b msi,updater`:

```
build hook.dll → SIGN hook.dll (action; also installs the TrustedSigning PS module)
  → stage it → npm run build (frontend)
  → tauri build -b msi,updater --config .tauri-release-config.json
      (compile → signCommand exe → MSI → signCommand MSI → zip + minisign)
  → verify exe + MSI signatures, zip + .sig exist
  → hand-build latest.json → gh release create --target <sha>  (creates the tag)
```

Details that look wrong but are deliberate:

- **`hook.dll` is signed separately** because it is a `resources` entry
  (`src-tauri/tauri.conf.json:98`) and the Tauri v1 bundler does not sign resources. It is
  also the file AV scrutinises most, since it is injected into the game process. The
  signing-action step doubles as the installer of the TrustedSigning PowerShell module
  that `ci-sign.ps1` needs — keep it BEFORE the build step.
- **`signCommand` lives only in the CI-written overlay** (`.tauri-release-config.json`),
  never in `tauri.conf.json` — local `build.ps1` builds stay unsigned and need no Azure
  credentials.
- **Do not resurrect a two-pass "build, sign, rebuild" scheme.** It was tried and is
  unfixable in Tauri v1 (runs 29937005294 / 29939406830): the CLI *moves* cargo's output
  exe to "GBFR Logs.exe" and cargo restores the missing output unsigned from `deps/`; with
  the copy-back workaround, pass 2 STILL relinks because (a) `-b none` vs `-b msi` changes
  `TAURI_CONFIG`, which tauri-build watches via rerun-if-env-changed, and (b) with
  identical `-b msi` commands, the WiX bundler rewrites `OUT_DIR\icon.ico` after linking,
  dirtying the compile fingerprint (proven via CARGO_LOG fingerprint tracing). Either way
  the signed exe is silently replaced.
- **RFC3161 timestamping is load-bearing, not decorative.** Issued certs live ~3 days
  (`createdDate 7/22/2026`, `expiryDate 7/25/2026`). The timestamp is the only reason a
  signature stays valid after the cert expires. Remove it and every shipped binary starts
  failing validation within 72 hours.
- **`latest.json` replaces spaces with dots** in the asset name. GitHub rewrites uploaded
  filenames that way, so `GBFR Logs_1.12.0_x64_en-US.msi.zip` downloads as
  `GBFR.Logs_1.12.0_x64_en-US.msi.zip`. Getting this wrong 404s every update.
- **The tag is created by `gh release create --target $GITHUB_SHA`, atomically with the
  release.** There is no separate tag push. A failed release job therefore strands nothing —
  the next push to main retries the same version. `--target` pins the tag to the exact
  commit that was built, even if main has moved on during the ~20-minute build. A
  `concurrency: release` group stops two rapid merges racing the version check.
- **No `TAURI_PRIVATE_KEY` in the build passes.** Neither pass produces an updater artifact
  (`updater` was removed from `bundle.targets`; the `.msi.zip` is built by hand from the
  signed MSI), so the key is only in scope for the one minisign step. The key is
  unencrypted, hence the literal `--password ""`. The `.msi.zip.sig` is not uploaded as a
  release asset — the updater reads the signature from `latest.json`, never from a file.

---

## 2. What is provisioned

Subscription `f6c62a00-7cef-4a6a-8a25-37b3ac8decfa` (Pay-As-You-Go), tenant
`3bdbff70-8f8a-406c-813a-a18c19f0a343`, portal login `scoot.donnelly@gmail.com`.

| Resource | Value |
|---|---|
| Resource group | `rg-relink-logs-signing` (eastus) |
| Signing account | `relinklogs` (Basic) → `https://eus.codesigning.azure.net/` |
| Certificate profile | `relinklogs-public` (PublicTrust) |
| Identity validation id | `d72c706e-1e65-4aec-b34b-d321b2cfce7c` |
| Service principal | `relink-logs-signing`, appId `4914afaf-edd2-47fd-a99a-6620e3a73e49` |
| Budget | `relink-logs-monthly`, $20/mo, alerts at 50/80/100% actual + 100% forecast |

Role assignments, both at account scope:

- service principal → **Artifact Signing Certificate Profile Signer** (signing)
- user → **Artifact Signing Identity Verifier** (submitting identity validation)

Issued certificate subject:

```
CN=Scott Donnelly, O=Scott Donnelly, L=Toronto, S=on, C=CA
```

Street address and postal code are stored on the Azure profile resource but excluded from
the certificate (`--include-street-address false --include-postal-code false`). The
`includeCity`/`includeState`/`includeCountry` flags are inert for `PublicTrust` — CA/Browser
Forum rules make L/S/C mandatory.

### Repo config — `villith/relink-logs`

The local `fork` remote still says `villith/gbfr-logs`; GitHub redirects the renamed repo, so
both resolve. The `latest.json` URL correctly uses `relink-logs`.

| Secrets | Variables |
|---|---|
| `AZURE_CLIENT_ID` | `AZURE_SIGNING_ENDPOINT` = `https://eus.codesigning.azure.net/` |
| `AZURE_CLIENT_SECRET` | `AZURE_SIGNING_ACCOUNT` = `relinklogs` |
| `AZURE_TENANT_ID` | `AZURE_CERT_PROFILE` = `relinklogs-public` |
| `TAURI_PRIVATE_KEY` | |

`TAURI_KEY_PASSWORD` does not exist as a secret — the updater key is unencrypted, and the
build step sets `TAURI_KEY_PASSWORD: ""` explicitly for the bundler's minisign pass.
Also configured on the repo (by the user; the agent cannot touch credentials/rulesets):
the `release-bot` write deploy key + `RELEASE_DEPLOY_KEY` secret, ruleset `main`
(id 19145403) pinned to `refs/heads/main`, and ruleset `dev` (id 19568411) mirroring it —
both with admin + DeployKey bypass actors.

---

## 3. What is proven / still untested

Proven live on 2026-07-22 (runs 29934578705 → 29940437510): the version job on both
branches, deploy-key pushes through both rulesets, the `chore(release):` recursion guard
(bump-triggered run self-skipped), Azure Artifact Signing auth + hook.dll/exe signing with
RFC3161 timestamps, and idempotent retry after a failed run (no tag → same version
recomputed, no duplicate bump commit). Compile against tauri 1.8.3 checked clean locally.

Still unproven, in descending order of risk:

1. **The bundler's signCommand path end-to-end** (exe + MSI signed inside `tauri build`,
   updater zip built from the signed MSI, minisign with `TAURI_KEY_PASSWORD=""`).
2. **A real updater consuming the artifacts** — install a lower-version build pointed at
   the RC's versioned `latest.json` and let it update (see §4).
3. **The hand-built `latest.json`** shape, `pub_date` format, space-to-dot URL.
4. **The whole stable path**: workflow_dispatch strip commit, changelog gate, publish,
   promote fast-forward of main — never executed.

A failed release job strands nothing — the tag is created atomically with the release at
the final step, so any earlier failure just retries on the next push or dispatch.

---

## 4. The release flow (final design — fast-forward model)

Versions are **CI-managed**; nobody hand-bumps them anymore.

- **PRs target `dev`** (the default branch). Every push to dev auto-bumps to the next RC
  version `X.Y.Z-N`, commits the bump to the five version files (`package.json`,
  `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock` —
  via `scripts/set-version.mjs`; the npm pair goes through `npm version`, which never
  re-resolves dependencies), and publishes a fully signed GitHub **prerelease**. GitHub
  never serves prereleases from `releases/latest/download/...` — the endpoint installed
  apps poll — so users cannot see RCs; testers download them from the releases page.
- **Releasing = pressing "Run workflow"** on the Release workflow (from dev). CI strips
  the RC suffix on dev (`chore(release): X.Y.Z`), refuses to proceed without a
  human-written `## X.Y.Z` CHANGELOG section, builds/signs/publishes the stable release,
  then **fast-forwards main** to the released commit.
- **main is only a pointer** to the last released state of dev — always an ancestor, so
  the branches can never diverge and nothing is ever merged back. The promote push is a
  plain non-force push: if main was ever pushed directly it fails loudly. Hotfix = normal
  PR to dev, then press release.
- **Version choice** (`scripts/next-version.mjs`, tag-driven): base = the files' version
  when ahead of the newest stable tag (set e.g. `1.13.0` in a PR to make the next release
  minor), else newest stable + patch. RC number = next untagged `-N`. N must be numeric
  ≤ 65535 — WiX turns it into the MSI ProductVersion's 4th field; `-rc.1` fails the build.
- **CI pushes use the `RELEASE_DEPLOY_KEY` write deploy key** (rulesets block direct
  pushes; personal repos can't grant the Actions app a bypass, a deploy key CAN be a
  bypass actor). Deploy-key pushes trigger workflows, so every CI commit starts with
  `chore(release):` and the version job skips those pushes.
- RC→stable upgrades are safe end-to-end: Tauri's WiX template sets
  `AllowSameVersionUpgrades="yes"` (MSI sees `1.12.0.1`→`1.12.0.0` as same version) and
  semver orders `1.12.0-1 < 1.12.0`, so installed RCs get offered the stable.

To hand-test the updater flow: build a local app with a lower version whose updater
endpoint points at an RC's **versioned** URL
(`.../releases/download/<X.Y.Z-N>/latest.json` — versioned URLs serve prereleases; only
`/latest` filters them), install, let it update. That exercises manifest parse → minisign
verify of the `Compress-Archive` zip → MSI install.

Note on rulesets: `required_signatures` on dev means contributor PRs need signed commits
unless squash-merged (the squash commit is GitHub-signed) or bypass-merged by an admin, and
the mirrored 1-approval requirement means solo PRs need the admin "merge without waiting
for requirements" checkbox. Both live in ruleset `dev` (id 19568411) and are easy to relax.

---

## 5. Operational notes

- **`az` is not on the inherited PATH** in agent shells. Refresh it per call:
  ```powershell
  $env:PATH = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  ```
- **The service is now "Azure Artifact Signing"**, renamed from "Trusted Signing". The old
  name survives in the CLI extension (`az trustedsigning`) and the action
  (`azure/trusted-signing-action`, pinned to `@v2`), but RBAC roles use *Artifact Signing*.
  Searching roles for "Trusted Signing" returns nothing.
- **Identity validation is not an ARM resource.** REST returns
  `ResourceTypeRegistrationNotFound`, and `az resource list` never shows it. Read its GUID
  off the portal blade.
- **`az trustedsigning check-name-availability` is broken** in extension 1.0.0b2 — it sends a
  request body missing the required `type` field. Let `create` fail instead.
- **Artifact Signing refuses free, trial, and sponsored subscriptions.** The subscription was
  upgraded to Pay-As-You-Go on 2026-07-22.
- **Azure enforces no hard spending cap** on Pay-As-You-Go. The budget only sends email; the
  spending limit disappeared with the free trial. Real exposure is the flat ~$9.99/mo, since
  Basic includes 5,000 signatures and a release signs three files.

---

## 6. Where the work lives

Commits `41d4f07`..`ee93505` on the `dev` branch of `villith/relink-logs`: the workflow,
`scripts/next-version.mjs` / `set-version.mjs` / `ci-sign.ps1`, the tauri 1.8.3 dependency
bumps, the `updater`-target removal in `tauri.conf.json`, the `build.ps1` exit-code
cleanup, and the building-gbfr-logs skill update. The signing work is intentionally NOT on
`feat/perfect-guard-stun`. main still carries the OLD tauri-action workflow, but it no
longer triggers releases from pushes (main is only moved by the promote fast-forward, and
the first stable release will bring the new workflow to main automatically).

Merging PR #16 (version 1.12.0 + `setMinSize`/`setSize` allowlist keys committed on the
feature branch) into dev will hit trivial overlap with dev's version files — versions are
CI-managed now, so resolve version-file conflicts in favor of ANY valid version; the next
bump rewrites them. Releases still require a `CHANGELOG.md` section written by a human —
the release dispatch fails without one, and agents must never write it.
