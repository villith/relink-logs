import { Box, Button, Checkbox, Fieldset, Group, Stack, Text, Tooltip } from "@mantine/core";
import { invoke } from "@tauri-apps/api";
import { emit } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { EncounterState, EncounterStatus, HookState, HookStatusSnapshot } from "@/types";

/** Dev-only tools. Reachable via the DEV-gated Debug tab; the hook/encounter
 * triggers emit the very events the backend normally sends, so the overlay
 * (Meter window) and header badge update through their real listeners. A live
 * game overrides the simulation on its next update. */

const emitHook = (state: HookState, supportsEject: boolean) => {
  // `simulated` tells HookStatusBadge to fake the refresh instead of running the
  // real backend command, which would act on true hook state, not this sim.
  const snapshot: HookStatusSnapshot = { state, hookVersion: "debug", appVersion: "debug", supportsEject, simulated: true };
  void emit("hook-status", snapshot);
};

const emitEncounter = (status: EncounterStatus, totalDamage: number, startTime: number, endTime: number) => {
  const durationSeconds = Math.max((endTime - startTime) / 1000, 1);
  const payload: EncounterState = {
    totalDamage,
    dps: totalDamage > 0 ? Math.round(totalDamage / durationSeconds) : 0,
    startTime,
    endTime,
    party: {},
    targets: {},
    status,
  };
  void emit("encounter-update", payload);
};

const DebugPage = () => {
  const { t } = useTranslation();
  const [fullAssistUnlock, setFullAssistUnlock] = useState(false);

  // Backend state, not store state: the injected hook reads this file once at
  // launch, so the checkbox reflects what the NEXT game launch will do.
  useEffect(() => {
    invoke<boolean>("get_full_assist_unlock")
      .then(setFullAssistUnlock)
      .catch((e) => console.error("Could not read the Full Assist unlock setting:", e));
  }, []);

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
            <Button variant="light" color="green" onClick={() => emitHook("connected", true)}>
              {t("ui.debug.hook-connected")}
            </Button>
            <Button variant="light" color="yellow" onClick={() => emitHook("reconnecting", true)}>
              {t("ui.debug.hook-reconnecting")}
            </Button>
            <Button variant="light" color="yellow" onClick={() => emitHook("outOfDate", true)}>
              {t("ui.debug.hook-out-of-date-refreshable")}
            </Button>
            <Button variant="light" color="yellow" onClick={() => emitHook("outOfDate", false)}>
              {t("ui.debug.hook-out-of-date-restart")}
            </Button>
            <Button variant="light" color="gray" onClick={() => emitHook("disconnected", false)}>
              {t("ui.debug.hook-no-game")}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {t("ui.debug.simulate-note")}
          </Text>
        </Stack>
      </Fieldset>

      <Fieldset legend={t("ui.debug.encounter-state")} mt="md">
        <Stack gap="xs">
          <Group gap="xs">
            <Button variant="light" color="gray" onClick={() => emitEncounter("Stopped", 0, 0, 1)}>
              {t("ui.debug.encounter-idle")}
            </Button>
            <Button variant="light" color="blue" onClick={() => emitEncounter("InProgress", 1_000_000, Date.now(), Date.now())}>
              {t("ui.debug.encounter-in-progress")}
            </Button>
            <Button variant="light" color="blue" onClick={() => emitEncounter("Stopped", 123_456_789, 0, 92_000)}>
              {t("ui.debug.encounter-stopped")}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {t("ui.debug.simulate-note")}
          </Text>
        </Stack>
      </Fieldset>
    </Box>
  );
};

export default DebugPage;
