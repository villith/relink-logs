// Copies the freshly-built console hook DLL into place as src-tauri/hook-dbg.dll,
// which `check_and_perform_hook` injects in preference to hook.dll in debug builds
// (see src-tauri/src/main.rs). `npm run dev` builds target/release/hook.dll with the
// `console` feature but does not place it there, so without this step `tauri dev`
// keeps injecting a STALE hook-dbg.dll from a previous session — the running game
// then never loads your latest hook changes.
//
// The copy is best-effort: if the game is running the DLL is locked, so we WARN and
// continue (the dev server must still start). Close the game and re-run to pick up
// the new DLL.
//
// It also DELETES any target/debug/hook-dbg.dll: the injector's search is
// filename-major over [exe dir, CWD], so a hook-dbg.dll next to the dev exe
// shadows the src-tauri one this script maintains — an orphan there (from the
// pre-script workflow of copying next to the exe) kept a 2026-08-05 session
// injecting a day-old hook through every rebuild.
import { copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "target/release/hook.dll");
const dst = resolve(root, "src-tauri/hook-dbg.dll");
const shadow = resolve(root, "target/debug/hook-dbg.dll");

try {
  rmSync(shadow, { force: true });
} catch (err) {
  console.warn(
    `[refresh-dbg-hook] WARNING: stale ${shadow} exists and could not be removed ` +
      `(${err.code}) — it SHADOWS the refreshed hook-dbg.dll and the game will ` +
      `keep loading the old hook. Close the game and delete it.`
  );
}

try {
  copyFileSync(src, dst);
  console.log(`[refresh-dbg-hook] copied ${src} -> ${dst}`);
} catch (err) {
  if (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") {
    console.warn(
      `[refresh-dbg-hook] WARNING: could not overwrite hook-dbg.dll (${err.code}) — ` +
        `the game is likely running and has it locked. Close the game so the fresh ` +
        `hook-dbg.dll can be injected on next launch. Continuing.`
    );
  } else if (err.code === "ENOENT") {
    console.warn(
      `[refresh-dbg-hook] WARNING: ${src} not found — hook build may have failed. Continuing.`
    );
  } else {
    console.warn(`[refresh-dbg-hook] WARNING: ${err.message}. Continuing.`);
  }
}
