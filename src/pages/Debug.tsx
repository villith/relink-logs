import { Box, Button, Checkbox, Fieldset, Group, Stack, Text, Tooltip } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";

import { backendErrorMessage } from "@/backendErrors";
import { useHookStatus } from "@/useHookStatus";

/** Dev-only tools. Every action here drives the REAL hook over the dev control
 * channel: hook status comes from real handshakes and encounter status from real
 * frames through the real parser. The frontend fakes nothing here. */

type Scenario = "start" | "tick" | "end" | "reset";

const DebugPage = () => {
  const { t } = useTranslation();
  const hook = useHookStatus();
  const [fullAssistUnlock, setFullAssistUnlock] = useState(false);
  const [heldOut, setHeldOut] = useState(false);
  const [busy, setBusy] = useState(false);

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
  const readHoldOut = useCallback(() => {
    invoke<boolean>("debug_hold_out_state")
      .then(setHeldOut)
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
  const run = async (task: () => Promise<unknown>, onDone?: (result: unknown) => void) => {
    setBusy(true);
    try {
      const result = await task();
      onDone?.(result);
    } catch (e) {
      toast.error(backendErrorMessage(t, "hook", String(e)) ?? String(e));
    } finally {
      setBusy(false);
      // Eject-with-hold and allow-reinject both move the gate, and a failed
      // eject moves it back, so re-read after every action — not only the ones
      // that were supposed to touch it.
      readHoldOut();
    }
  };

  const sendScenario = (kind: Scenario) =>
    run(
      () => invoke<number>("debug_broadcast_scenario", { kind }),
      (result) => {
        const count = result as number;
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

  return (
    <Box p="sm">
      <Fieldset legend={t("ui.debug.full-assist")}>
        <Tooltip label={t("ui.full-assist-unlock-description")}>
          <Checkbox label={t("ui.full-assist-unlock")} checked={fullAssistUnlock} onChange={toggleFullAssistUnlock} />
        </Tooltip>
      </Fieldset>

      <Fieldset legend={t("ui.debug.hook-state")} mt="md">
        <Stack gap="xs">
          <Group gap="xs">
            <Button variant="light" color="blue" loading={busy} onClick={() => run(() => invoke("refresh_hook"))}>
              {t("ui.debug.hook-refresh")}
            </Button>
            <Button
              variant="light"
              color="gray"
              loading={busy}
              onClick={() => run(() => invoke("debug_eject_hook", { hold: true }))}
            >
              {t("ui.debug.hook-eject-hold")}
            </Button>
            <Button
              variant="light"
              color="green"
              loading={busy}
              onClick={() => run(() => invoke("debug_allow_reinject"))}
            >
              {t("ui.debug.hook-allow-reinject")}
            </Button>
            <Button
              variant="light"
              color="gray"
              loading={busy}
              onClick={() => run(() => invoke("debug_eject_hook", { hold: false }))}
            >
              {t("ui.debug.hook-eject-once")}
            </Button>
          </Group>
          <Group gap="xs">
            <Button
              variant="light"
              color="yellow"
              loading={busy}
              onClick={() =>
                run(() => invoke("debug_set_hello_override", { hookVersion: "0.0.1", supportsEject: true }))
              }
            >
              {t("ui.debug.hook-force-out-of-date")}
            </Button>
            <Button
              variant="light"
              color="yellow"
              loading={busy}
              onClick={() =>
                run(() => invoke("debug_set_hello_override", { hookVersion: "0.0.1", supportsEject: false }))
              }
            >
              {t("ui.debug.hook-force-restart-required")}
            </Button>
            <Button
              variant="light"
              color="green"
              loading={busy}
              onClick={() => run(() => invoke("debug_clear_hello_override"))}
            >
              {t("ui.debug.hook-clear-override")}
            </Button>
          </Group>
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
          <Text size="xs" c="dimmed">
            {t("ui.debug.stale-hook-note")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("ui.debug.real-note")}
          </Text>
        </Stack>
      </Fieldset>

      <Fieldset legend={t("ui.debug.encounter-state")} mt="md">
        <Stack gap="xs">
          <Group gap="xs">
            <Button variant="light" color="blue" loading={busy} onClick={() => sendScenario("start")}>
              {t("ui.debug.encounter-start")}
            </Button>
            <Button variant="light" color="blue" loading={busy} onClick={() => sendScenario("tick")}>
              {t("ui.debug.encounter-tick")}
            </Button>
            <Button variant="light" color="green" loading={busy} onClick={() => sendScenario("end")}>
              {t("ui.debug.encounter-end")}
            </Button>
            <Button variant="light" color="gray" loading={busy} onClick={() => sendScenario("reset")}>
              {t("ui.debug.encounter-reset")}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {t("ui.debug.real-note")}
          </Text>
        </Stack>
      </Fieldset>
    </Box>
  );
};

export default DebugPage;
