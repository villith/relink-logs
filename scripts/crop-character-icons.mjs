/**
 * Crops the transparent border off the character icon PNGs, in place.
 *
 * The sprites come out of the game's atlas on a fixed canvas with the art
 * floating inside it — every bust in `mini/` carries a transparent margin it
 * does not use. That margin costs real pixels in the meter: the icon is sized
 * from the bar height, so blank rows at the top and bottom shrink the FACE for
 * a given bar. Trimming the sources means the same box is spent on art.
 *
 * ONE rect is applied to every file in a family, not a per-image trim. The
 * icons are a set that gets drawn side by side, and a per-image trim silently
 * rescales each character against the others — a character drawn compact would
 * come out zoomed next to one drawn wide, and the crop would shift again the
 * next time the game adds a character. A shared rect leaves the set mutually
 * consistent.
 *
 * The two axes are not chosen the same way, because they are not worth the
 * same. HEIGHT is the union of every content box: vertical room is where the
 * face is drawn, so nothing is cut that any file uses. WIDTH defaults to that
 * union but is meant to be given (`--width`), because the busts are drawn to
 * very different widths — 130px of art against 222px on a 256px canvas — and a
 * rect that clears the widest keeps everyone else's blank. Trading a little
 * clipping on the widest few for a box that is narrower for all 32 is the
 * point; the run prints exactly which files it cuts and by how much, and
 * `--dry-run` costs those choices out over a range of candidate widths first.
 *
 * Idempotent by construction: whatever rect is used, some file ends up touching
 * each edge, so a second run computes the full canvas and writes nothing. Safe
 * to re-run after re-extracting the atlas, which is the point — see the icon
 * README for where the sprites come from.
 *
 *   node scripts/crop-character-icons.mjs --dry-run
 *   node scripts/crop-character-icons.mjs --width 192
 *   [--dir <path>] [--alpha N] [--left N]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DEFAULT_DIR = "src/assets/character-icons/mini";
/** Alpha at or above which a pixel counts as art. Above zero so the atlas
 * slicer's antialias fringe does not pin the box back to the full canvas. */
const DEFAULT_ALPHA = 8;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const dir = path.resolve(value("--dir", DEFAULT_DIR));
const alphaMin = Number(value("--alpha", DEFAULT_ALPHA));
const dryRun = flag("--dry-run");

/** The tight box around everything at or above `alphaMin`, or null if empty. */
const contentBox = (data, { width, height, channels }) => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] >= alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
};

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".png")).sort();
if (files.length === 0) {
  console.error(`No PNGs in ${dir}`);
  process.exit(1);
}

const measured = [];
for (const file of files) {
  const source = await readFile(path.join(dir, file));
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = contentBox(data, info);
  if (!box) {
    console.error(`${file} is fully transparent — refusing to guess a crop for the set`);
    process.exit(1);
  }
  measured.push({ file, source, info, box });
}

const canvas = measured[0].info;
const mismatched = measured.filter((m) => m.info.width !== canvas.width || m.info.height !== canvas.height);
if (mismatched.length > 0) {
  console.error(
    `Mixed canvas sizes in ${dir} — a shared crop needs one canvas:\n` +
      mismatched.map((m) => `  ${m.file} ${m.info.width}x${m.info.height}`).join("\n")
  );
  process.exit(1);
}

const union = measured.reduce(
  (a, m) => ({
    minX: Math.min(a.minX, m.box.minX),
    minY: Math.min(a.minY, m.box.minY),
    maxX: Math.max(a.maxX, m.box.maxX),
    maxY: Math.max(a.maxY, m.box.maxY),
  }),
  { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 }
);

/** Total pixels of art the window [left, left+width) would cut off the sides. */
const clipCost = (left, width) =>
  measured.reduce((sum, m) => sum + Math.max(0, left - m.box.minX) + Math.max(0, m.box.maxX - (left + width - 1)), 0);

/** Where to put a window of `width`: the offset that cuts the least art, and of
 * equally-good offsets the one nearest the canvas centre, so the set stays
 * visually centred rather than drifting toward one outlier. */
const bestLeft = (width) => {
  const centred = Math.round((canvas.width - width) / 2);
  let best = centred;
  let bestCost = clipCost(centred, width);
  for (let left = 0; left + width <= canvas.width; left++) {
    const cost = clipCost(left, width);
    if (cost < bestCost || (cost === bestCost && Math.abs(left - centred) < Math.abs(best - centred))) {
      best = left;
      bestCost = cost;
    }
  }
  return best;
};

// The width is a judgement call, not a measurement: the busts are drawn to
// different widths and the widest few carry outstretched weapons, so a rect
// that clears everything keeps the blank the narrow ones brought with them.
// Height is not — it is trimmed only where every file is blank, since vertical
// room is what the face is drawn in.
const width = Number(value("--width", union.maxX - union.minX + 1));
const rect = {
  left: Number(value("--left", bestLeft(width))),
  top: union.minY,
  width,
  height: union.maxY - union.minY + 1,
};
const trimmed = {
  left: rect.left,
  top: rect.top,
  right: canvas.width - (rect.left + rect.width),
  bottom: canvas.height - (rect.top + rect.height),
};

console.log(`${files.length} icons in ${path.relative(process.cwd(), dir)} at ${canvas.width}x${canvas.height}`);
console.log(`content box of the set: ${rect.width}x${rect.height} at +${rect.left}+${rect.top}`);
console.log(`  trims L${trimmed.left} T${trimmed.top} R${trimmed.right} B${trimmed.bottom}`);

if (rect.width === canvas.width && rect.height === canvas.height) {
  console.log("Already tight — nothing to crop.");
  process.exit(0);
}

const pct = (n, of) => `${((n / of) * 100).toFixed(1)}%`;
console.log(
  `  keeps ${pct(rect.width, canvas.width)} of the width, ${pct(rect.height, canvas.height)} of the height` +
    ` (aspect ${(rect.width / rect.height).toFixed(4)})`
);

/** What the chosen rect costs each file, so a clip is never a surprise. */
const clipped = measured
  .map((m) => ({
    file: m.file,
    left: Math.max(0, rect.left - m.box.minX),
    right: Math.max(0, m.box.maxX - (rect.left + rect.width - 1)),
  }))
  .filter((c) => c.left > 0 || c.right > 0);

if (clipped.length > 0) {
  console.log(`\nclips ${clipped.length} of ${files.length} icons at the sides:`);
  for (const c of clipped) console.log(`  ${c.file}  left ${c.left}px  right ${c.right}px`);
} else {
  console.log("\nclips nothing — every icon's art fits the rect.");
}

// The CSS crops the bottom of the icon by making its box wider per unit height
// than the source; the denominator IS the number of source rows it shows. Both
// numbers move when this rect does, so print the pair rather than leave someone
// to re-derive it. See `.player-label-icon` in App.css.
const KEPT_ROWS_IN_ORIGINAL = 185;
console.log(
  `\nApp.css .player-label-icon width should become:\n` +
    `  calc(var(--player-icon-height, 1.6em) * ${rect.width} / ${KEPT_ROWS_IN_ORIGINAL - rect.top})`
);

if (dryRun) {
  console.log("\n--dry-run: no files written. Per-image content boxes:");
  for (const m of measured) {
    console.log(
      `  ${m.file}  ${String(m.box.maxX - m.box.minX + 1).padStart(3)}x${String(m.box.maxY - m.box.minY + 1).padStart(3)}` +
        ` at +${String(m.box.minX).padStart(3)}+${String(m.box.minY).padStart(3)}`
    );
  }
  const candidates = [160, 168, 176, 184, 192, 200, 208, 216, rect.width].sort((a, b) => a - b);
  console.log("\ncandidate widths (art cut, summed over the set):");
  for (const w of [...new Set(candidates)]) {
    const left = bestLeft(w);
    const hit = measured.filter((m) => m.box.minX < left || m.box.maxX > left + w - 1).length;
    const worst = measured.reduce(
      (a, m) => Math.max(a, Math.max(0, left - m.box.minX), Math.max(0, m.box.maxX - (left + w - 1))),
      0
    );
    console.log(
      `  ${String(w).padStart(3)}px at +${String(left).padStart(3)}  cuts ${String(clipCost(left, w)).padStart(5)}px` +
        ` across ${String(hit).padStart(2)} icons, worst ${worst}px on one side`
    );
  }
  process.exit(0);
}

for (const m of measured) {
  const out = await sharp(m.source).extract(rect).png().toBuffer();
  await writeFile(path.join(dir, m.file), out);
}
console.log(`Cropped ${measured.length} icons to ${rect.width}x${rect.height}.`);
