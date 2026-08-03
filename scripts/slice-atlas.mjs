/**
 * Slices a game UI atlas into per-sprite PNGs, driven by its sprite table.
 *
 * The game packs UI icons into big BC7 atlases (`ui/atlas/*.wtb`) with a
 * companion sprite table (`*.tex.texb`) that GBFRDataTools' `b-convert`
 * decodes to YAML — one entry per sprite with a destination canvas (`Rect`),
 * the atlas UVs (`Uv`) and the transparent margin the art sits inside
 * (`Padding`). This script re-cuts those sprites out of the atlas PNG. See
 * src/assets/character-icons/README.md for the full extraction pipeline and
 * for the two coordinate gotchas this script encodes:
 *
 *   1. `Uv` uses a BOTTOM-LEFT origin — the vertical crop is
 *      `(1 - v1) * height .. (1 - v0) * height`. Taking the UVs at face
 *      value fails quietly: the wrong rect is still a valid rect.
 *   2. `Rect`, `Uv` and `Padding` share one field order,
 *      `(left, bottom, right, top)` in that same bottom-left space, so the
 *      trimmed art composites at `(Padding[0], Padding[3])` on a
 *      `Rect`-sized canvas.
 *
 * The YAML is regular enough (fixed keys, one sprite per `- Name:` block)
 * that it is parsed here directly rather than pulling in a YAML dependency
 * for what is a dev-time script.
 *
 *   node scripts/slice-atlas.mjs --atlas icon-export/raw/ui/atlas/common_icon_status.PNG --out icon-export/sliced/status
 *   [--table <path>]   sprite table YAML; defaults to the atlas path with .tex.yaml
 *   [--match <regex>]  only slice sprites whose Name matches
 *   [--flat]           drop the sprite onto a bare crop, ignoring Rect/Padding
 *   [--dry-run]        list what would be written
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const atlasPath = value("--atlas");
const outDir = value("--out");
if (!atlasPath || !outDir) {
  console.error(
    "Usage: node scripts/slice-atlas.mjs --atlas <atlas.png> --out <dir> [--table <yaml>] [--match <regex>] [--flat] [--dry-run]"
  );
  process.exit(1);
}
const tablePath = value("--table", atlasPath.replace(/\.png$/i, ".tex.yaml"));
const match = value("--match") ? new RegExp(value("--match")) : null;
const flat = flag("--flat");
const dryRun = flag("--dry-run");

/** One sprite block out of the b-convert YAML. The format is a fixed set of
 * `Key: n, n, n, n` lines per sprite, so a line scanner is enough — but it
 * refuses anything it does not recognise rather than guessing. */
const parseSprites = (yaml) => {
  const sprites = [];
  let current = null;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    const name = /^- Name: (.+)$/.exec(line);
    if (name) {
      current = { name: name[1].trim() };
      sprites.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^(Rect|Padding|Uv): (.+)$/.exec(line);
    if (!field) continue;
    const nums = field[2].split(",").map((n) => Number(n.trim()));
    if (nums.some(Number.isNaN) || nums.length !== 4) {
      console.error(`Unparseable ${field[1]} for ${current.name}: ${field[2]}`);
      process.exit(1);
    }
    current[field[1].toLowerCase()] = nums;
  }
  return sprites.filter((s) => s.rect && s.uv);
};

const yaml = await readFile(tablePath, "utf8");
const sprites = parseSprites(yaml).filter((s) => !match || match.test(s.name));
if (sprites.length === 0) {
  console.error(`No sprites in ${tablePath}${match ? ` matching ${match}` : ""}`);
  process.exit(1);
}

const atlas = sharp(await readFile(atlasPath));
const { width: W, height: H } = await atlas.metadata();

// Names are file names; a duplicate would silently keep only the last sprite.
const seen = new Map();
for (const s of sprites) {
  if (seen.has(s.name)) {
    console.error(`Duplicate sprite name ${s.name} — refusing to overwrite silently`);
    process.exit(1);
  }
  seen.set(s.name, true);
}

let written = 0;
let skipped = 0;
const jobs = [];
for (const s of sprites) {
  const [u0, v0, u1, v1] = s.uv;
  const crop = {
    left: Math.round(u0 * W),
    top: Math.round((1 - v1) * H), // bottom-left origin: v1 is the TOP edge
    width: Math.round((u1 - u0) * W),
    height: Math.round((v1 - v0) * H),
  };
  if (crop.width <= 0 || crop.height <= 0) {
    skipped++;
    continue;
  }
  const canvas = { width: Math.round(s.rect[2] - s.rect[0]), height: Math.round(s.rect[3] - s.rect[1]) };
  const pad = s.padding ?? [0, 0, 0, 0];
  const at = { left: Math.round(pad[0]), top: Math.round(pad[3]) };
  // A crop that already fills (or overflows — UV rounding) its canvas needs no
  // compositing; sharp would refuse an input larger than its base anyway.
  const bare = flat || (canvas.width <= crop.width && canvas.height <= crop.height);
  jobs.push({ name: s.name, crop, canvas, at, bare });
}

if (dryRun) {
  for (const j of jobs)
    console.log(
      `${j.name}  ${j.crop.width}x${j.crop.height} at +${j.crop.left}+${j.crop.top}` +
        (j.bare ? "" : ` -> ${j.canvas.width}x${j.canvas.height} at +${j.at.left}+${j.at.top}`)
    );
  console.log(`${jobs.length} sprites (${skipped} zero-area skipped) — dry run, nothing written`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const atlasBuffer = await atlas.png().toBuffer();
for (const j of jobs) {
  let img = sharp(atlasBuffer).extract(j.crop);
  if (!j.bare) {
    // Padding can overhang the canvas by a subpixel of rounding; clamping keeps
    // the composite valid without visibly moving the art.
    const left = Math.min(j.at.left, Math.max(0, j.canvas.width - j.crop.width));
    const top = Math.min(j.at.top, Math.max(0, j.canvas.height - j.crop.height));
    img = sharp({
      create: {
        // Never smaller than the crop: one axis can overflow the canvas by a
        // pixel of UV rounding while the other still needs its margin.
        width: Math.max(j.canvas.width, j.crop.width),
        height: Math.max(j.canvas.height, j.crop.height),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite([{ input: await img.png().toBuffer(), left, top }]);
  }
  await writeFile(path.join(outDir, `${j.name}.png`), await img.png().toBuffer());
  written++;
}
console.log(`${written} sprites written to ${path.relative(process.cwd(), outDir)} (${skipped} zero-area skipped)`);
