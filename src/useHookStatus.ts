import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

import { HookStatusSnapshot } from "@/types";

/**
 * Shared hook status: seeds from `get_hook_status` on mount, then follows the
 * `hook-status` event (fired on connect, disconnect, and around a refresh).
 * Returns null until the first value arrives.
 */
export function useHookStatus(): HookStatusSnapshot | null {
  const [status, setStatus] = useState<HookStatusSnapshot | null>(null);

  useEffect(() => {
    invoke<HookStatusSnapshot>("get_hook_status")
      .then(setStatus)
      .catch(() => {});
    const unlisten = listen<HookStatusSnapshot>("hook-status", (e) => setStatus(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return status;
}
