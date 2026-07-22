import { platform } from "@tauri-apps/api/os";
import { useEffect, useState } from "react";

let cached: Promise<string> | null = null;

/** The OS the backend runs on ("win32" | "linux" | ...), cached for the app's lifetime. */
export function getPlatform(): Promise<string> {
  if (!cached) cached = platform();
  return cached;
}

/** False until the async platform lookup resolves — callers render the Windows/default UI first. */
export function useIsLinux(): boolean {
  const [isLinux, setIsLinux] = useState(false);
  useEffect(() => {
    let mounted = true;
    getPlatform().then((p) => {
      if (mounted) setIsLinux(p === "linux");
    });
    return () => {
      mounted = false;
    };
  }, []);
  return isLinux;
}
