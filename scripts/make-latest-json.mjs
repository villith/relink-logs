// Assembles the updater manifest (latest.json) from built updater artifacts.
// Usage: node scripts/make-latest-json.mjs <version> <notesFile> <assetDir> <owner/repo>
// Expects <assetDir> to contain, flat: *.msi.zip(+.sig) and *.AppImage.tar.gz(+.sig).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, notesFile, assetDir, repo] = process.argv.slice(2);
if (!version || !notesFile || !assetDir || !repo) {
  console.error("usage: make-latest-json.mjs <version> <notesFile> <assetDir> <owner/repo>");
  process.exit(1);
}

const files = readdirSync(assetDir);

// GitHub rewrites spaces in uploaded asset names to dots.
const assetUrl = (name) =>
  `https://github.com/${repo}/releases/download/${version}/${name.replaceAll(" ", ".")}`;

const platformEntry = (suffix) => {
  const artifact = files.find((f) => f.endsWith(suffix));
  if (!artifact) throw new Error(`no *${suffix} in ${assetDir}`);
  const sig = `${artifact}.sig`;
  if (!files.includes(sig)) throw new Error(`missing ${sig}`);
  return {
    signature: readFileSync(join(assetDir, sig), "utf8").trim(),
    url: assetUrl(artifact),
  };
};

const manifest = {
  version,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "windows-x86_64": platformEntry(".msi.zip"),
    "linux-x86_64": platformEntry(".AppImage.tar.gz"),
  },
};

writeFileSync(join(assetDir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log(readFileSync(join(assetDir, "latest.json"), "utf8"));
