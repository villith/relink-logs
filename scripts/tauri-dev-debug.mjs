// `npm run tauri:debug` — the normal Tauri dev loop, but with the WebView2
// window exposing the Chrome DevTools Protocol on a TCP port so an external
// debugger (Chrome's own inspector, or chrome-devtools-mcp) can attach to the
// running app and inspect the REAL UI against REAL parsed logs.
//
// The app renders in WebView2, not Chrome, so a plain Chrome tab cannot see it.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is the WebView2 loader's own escape
// hatch: whatever is in it is appended to the browser process command line.
// Attach with chrome://inspect, or point a CDP client at
// http://127.0.0.1:<port>/json/list — both app windows (the overlay at "/" and
// the logs window at "/logs") appear as separate targets.
//
// 9223, not 9222, so the app and an ordinary debug Chrome can be attached at the
// SAME time: `.mcp.json` serves 9222 as `chrome-devtools` (a browser, e.g. for a
// reference site) and 9223 as `chrome-devtools-app` (this app). Both wanting one
// port is what forced an earlier comparison to be done sequentially.
//
// Windows-only: WebView2 is the Windows webview. Under Proton/Linux the app
// runs the Windows exe anyway, but this script drives the host-side dev loop,
// so it refuses rather than pretending to work.
import { spawn } from "node:child_process";

const PORT = process.env.TAURI_DEBUG_PORT ?? "9223";

if (process.platform !== "win32") {
  console.error("[tauri-dev-debug] Windows-only: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is a WebView2 mechanism.");
  process.exit(1);
}

console.log(`[tauri-dev-debug] WebView2 remote debugging on http://127.0.0.1:${PORT}`);

// `npm run tauri dev` rather than the CLI directly, so this stays in step with
// whatever that script does (hook build, target prune) instead of duplicating it.
const child = spawn("npm", ["run", "tauri", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});

child.on("exit", (code) => process.exit(code ?? 0));

