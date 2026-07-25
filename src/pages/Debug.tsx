import { Box, Button, Checkbox, Fieldset, Group, Stack, Text, Tooltip } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";
import { useHookStatus } from "@/useHookStatus";

/** Dev-only tools. Every action here drives the REAL hook over the dev control
 * channel: hook status comes from real handshakes and encounter status from real
 * frames through the real parser. The frontend fakes nothing here. */

type Scenario = "start" | "tick" | "end" | "reset";

/** One hook-state button. `key` doubles as the spinner key and as the lookup
 * into `LABEL_KEYS`, so a failing action can name itself in its toast. */
type HookAction = {
  key: string;
  color: string;
  labelKey: string;
  command: string;
  args?: Record<string, unknown>;
};

/** Hook-state buttons, one array per rendered row. */
const HOOK_ROWS: HookAction[][] = [
  [
    { key: "refresh", color: "blue", labelKey: "ui.debug.hook-refresh", command: "refresh_hook" },
    {
      key: "eject-hold",
      color: "gray",
      labelKey: "ui.debug.hook-eject-hold",
      command: "debug_eject_hook",
      args: { hold: true },
    },
    {
      key: "allow-reinject",
      color: "green",
      labelKey: "ui.debug.hook-allow-reinject",
      command: "debug_allow_reinject",
    },
    {
      key: "eject-once",
      color: "gray",
      labelKey: "ui.debug.hook-eject-once",
      command: "debug_eject_hook",
      args: { hold: false },
    },
  ],
  [
    {
      key: "force-out-of-date",
      color: "yellow",
      labelKey: "ui.debug.hook-force-out-of-date",
      command: "debug_set_hello_override",
      args: { hookVersion: "0.0.1", supportsEject: true },
    },
    {
      key: "force-restart-required",
      color: "yellow",
      labelKey: "ui.debug.hook-force-restart-required",
      command: "debug_set_hello_override",
      args: { hookVersion: "0.0.1", supportsEject: false },
    },
    {
      key: "clear-override",
      color: "green",
      labelKey: "ui.debug.hook-clear-override",
      command: "debug_clear_hello_override",
    },
  ],
];

/** Encounter-state buttons. The scenario name is the busy key. */
const SCENARIO_ROW: { key: Scenario; color: string; labelKey: string }[] = [
  { key: "start", color: "blue", labelKey: "ui.debug.encounter-start" },
  { key: "tick", color: "blue", labelKey: "ui.debug.encounter-tick" },
  { key: "end", color: "green", labelKey: "ui.debug.encounter-end" },
  { key: "reset", color: "gray", labelKey: "ui.debug.encounter-reset" },
];

/** Busy key → label key. A mapped backend slug ("No game found") says nothing
 * about which of eleven buttons produced it, so the toast names the action. */
const LABEL_KEYS: Record<string, string> = Object.fromEntries(
  [...HOOK_ROWS.flat(), ...SCENARIO_ROW].map((action) => [action.key, action.labelKey])
);

const DebugPage = () => {
  const { t } = useTranslation();
  const hook = useHookStatus();
  const [fullAssistUnlock, setFullAssistUnlock] = useState(false);
  const [heldOut, setHeldOut] = useState(false);
  // The key of the running action, or null. One action at a time (they all
  // drive one hook over a one-request-per-connection channel), but only the
  // clicked button spins — `loading` on all eleven would read as eleven
  // concurrent operations.
  const [busy, setBusy] = useState<string | null>(null);

  // Backend state, not store state: the injected hook reads this file once at
  // launch, so the checkbox reflects what the NEXT game launch will do.
  useEffect(() => {
    invoke<boolean>("get_full_assist_unlock")
      .then(setFullAssistUnlock)
      .catch((e) => console.error("Could not read the Full Assist unlock setting:", e));
  }, []);

  // Pull-only: the hold-out gate has no event of its own. Three things write it
  // (this page, `refresh_hook`, `reload_hook`), the latter two behind this
  // page's back, so re-read it on every `hook-status` rather than remembering
  // what we last set. A stale "held out" badge here would be worse than none:
  // a set hold makes the status badge read "No game found" with a game running.
  const holdOutGeneration = useRef(0);
  const readHoldOut = useCallback(() => {
    // Three callers (mount, `hook-status`, `run`'s finally) can have reads in
    // flight at once, and nothing makes them resolve in order — apply only the
    // newest, so an older response can't land last and restore a stale value.
    const generation = ++holdOutGeneration.current;
    invoke<boolean>("debug_hold_out_state")
      .then((held) => {
        if (generation === holdOutGeneration.current) setHeldOut(held);
      })
      .catch((e) => console.error("Could not read the hook hold-out state:", e));
  }, []);

  useEffect(() => {
    readHoldOut();
    const unlisten = listen("hook-status", () => readHoldOut());
    return () => {
      unlisten.then((f) => f());
    };
  }, [readHoldOut]);

  const toggleFullAssistUnlock = async () => {
    const enabled = !fullAssistUnlock;
    setFullAssistUnlock(enabled);
    try {
      await invoke("set_full_assist_unlock", { enabled });
    } catch (e) {
      console.error("Could not write the Full Assist unlock setting:", e);
      setFullAssistUnlock(!enabled);
    }
  };

  /** Run a dev command, surfacing backend slugs as friendly copy. */
  const run = async <T,>(key: string, task: () => Promise<T>, onDone?: (result: T) => void) => {
    setBusy(key);
    try {
      const result = await task();
      onDone?.(result);
    } catch (e) {
      const error = backendErrorMessage(t, "hook", String(e)) ?? String(e);
      toast.error(t("ui.debug.action-failed", { action: t(LABEL_KEYS[key]), error }));
    } finally {
      setBusy(null);
      // Eject-with-hold and allow-reinject both move the gate, and a failed
      // eject moves it back, so re-read after every action — not only the ones
      // that were supposed to touch it.
      readHoldOut();
    }
  };

  const sendScenario = (kind: Scenario) =>
    run(
      kind,
      () => invoke<number>("debug_broadcast_scenario", { kind }),
      (count) => {
        if (count === 0) {
          // The backend refuses an empty batch and early-returns
          // `game-not-running` when nothing is attached, so 0 is an invariant
          // violation: the hook queued onto a channel nobody reads.
          toast.error(t("ui.debug.sent-nothing"));
        } else {
          toast.success(t("ui.debug.sent-frames", { count }));
        }
      }
    );

  const actionButton = (key: string, color: string, labelKey: string, onClick: () => void) => (
    <Button key={key} variant="light" color={color} disabled={busy !== null} loading={busy === key} onClick={onClick}>
      {t(labelKey)}
    </Button>
  );

  const staleHookNote = (
    <Text size="xs" c="dimmed">
      {t("ui.debug.stale-hook-note")}
    </Text>
  );

  return (
    <Box p="sm">
      <Fieldset legend={t("ui.debug.full-assist")}>
        <Tooltip label={t("ui.full-assist-unlock-description")}>
          <Checkbox label={t("ui.full-assist-unlock")} checked={fullAssistUnlock} onChange={toggleFullAssistUnlock} />
        </Tooltip>
      </Fieldset>

      <Fieldset legend={t("ui.debug.hook-state")} mt="md">
        <Stack gap="xs">
          {HOOK_ROWS.map((row, index) => (
            <Group gap="xs" key={index}>
              {row.map((action) =>
                actionButton(action.key, action.color, action.labelKey, () =>
                  run(action.key, () => invoke(action.command, action.args))
                )
              )}
            </Group>
          ))}
          {/* Sourced from the real handshake, so an active override shows up
              here as the version the hook actually reports. */}
          <Text size="xs" c="dimmed">
            {t("ui.debug.current-hook", {
              version: hook?.hookVersion ?? t("ui.unknown"),
              state: hook?.state ?? t("ui.unknown"),
            })}
          </Text>
          {heldOut && (
            <Text size="xs" c="yellow">
              {t("ui.debug.hold-out-active")}
            </Text>
          )}
          {staleHookNote}
          <Text size="xs" c="dimmed">
            {t("ui.debug.hook-note")}
          </Text>
        </Stack>
      </Fieldset>

      <Fieldset legend={t("ui.debug.encounter-state")} mt="md">
        <Stack gap="xs">
          <Group gap="xs">
            {SCENARIO_ROW.map((action) =>
              actionButton(action.key, action.color, action.labelKey, () => sendScenario(action.key))
            )}
          </Group>
          {/* The scenario batch travels the same dev control channel as the
              hook-state buttons, so a stale hook-dbg.dll fails it identically. */}
          {staleHookNote}
          <Text size="xs" c="dimmed">
            {t("ui.debug.encounter-note")}
          </Text>
        </Stack>
      </Fieldset>
    </Box>
  );
};

export default DebugPage;
