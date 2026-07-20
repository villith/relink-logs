// Prints the CHANGELOG.md section for one version — the release workflow uses
// it as the GitHub release body, which tauri-action copies into latest.json as
// the updater dialog's notes. Exits nonzero when the section is missing so the
// workflow can refuse to release an unnoted version (checked before tagging).
//
// Usage:
//   node scripts/extract-changelog.mjs           -> section for package.json's version
//   node scripts/extract-changelog.mjs 1.10.0    -> section for an explicit version
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The body of `version`'s `## <version>` section (trailing heading text such
 * as a date is allowed), trimmed; null when the changelog has no such section. */
export const extractSection = (markdown, version) => {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The version must be the whole version, not a prefix of a longer one:
  // `## 1.10.0-rc.1` must not satisfy 1.10.0 (it would ship prerelease notes
  // as the release body). Trailing prose after a space — a date, a name — is
  // still allowed.
  const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?![\\w.+-])[^\\n]*$`, "m");
  const match = heading.exec(markdown);
  if (!match) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^##\s/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const section = extractSection(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), version);
  if (section === null || section === "") {
    console.error(`[extract-changelog] CHANGELOG.md has no "## ${version}" section — write one before releasing`);
    process.exit(1);
  }
  console.log(section);
}
