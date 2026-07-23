// `npm run dev` prelude. The hook crate only compiles for Windows targets, so
// on a Linux/macOS dev host we skip it (live-game work there uses a CI-built
// hook.dll dropped into src-tauri/). On Windows this preserves the exact
// feature set + hook-dbg refresh the dev loop has always used.
import { execSync } from "node:child_process";

if (process.platform === "win32") {
  execSync("cargo build --release --package hook --features hook/console,hook/hookdiag,hook/dmgdiag,hook/fullassist,hook/eject", {
    stdio: "inherit",
  });
  execSync("node scripts/refresh-dbg-hook.mjs", { stdio: "inherit" });
} else {
  console.log("[build-hook-dev] non-Windows host: skipping hook.dll build (windows-only crate).");
}
