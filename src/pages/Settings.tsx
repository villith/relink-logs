import { ColumnEditor } from "@/components/ColumnEditor";
import { useColumnControls } from "@/components/useColumnControls";
import { useIsLinux } from "@/platform";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useManualUpdateCheck } from "@/useUpdateCheck";
import { translateTraitId } from "@/utils";
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  ColorInput,
  Divider,
  Fieldset,
  Flex,
  Group,
  NumberInput,
  Select,
  Slider,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LinuxSetupSection } from "./settings/LinuxSetupSection";
import useChecklistSettings from "./useChecklistSettings";
import useSettings from "./useSettings";

export const ChecklistSection = ({
  group,
  legend,
  addPlaceholder,
  checklist,
}: {
  group: ChecklistGroup;
  legend: string;
  addPlaceholder: string;
  checklist: ReturnType<typeof useChecklistSettings>;
}) => {
  const entries = group === "build" ? checklist.build : checklist.ai;

  return (
    <Box>
      <Text size="sm" fw={600}>
        {legend}
      </Text>
      {entries.map((entry) => (
        <Flex key={entry.ids[0]} align="center" gap="xs" mt={4}>
          <Checkbox checked={entry.enabled} onChange={() => checklist.toggle(group, entry.ids[0])} />
          <Text size="sm" flex={1}>
            {translateTraitId(entry.ids[0])}
          </Text>
          <NumberInput
            value={entry.level}
            min={1}
            step={1}
            w={90}
            onChange={(value) => checklist.setEntryLevel(group, entry.ids[0], value)}
          />
          <ActionIcon
            aria-label="Remove entry"
            variant="transparent"
            color="gray"
            onClick={() => checklist.remove(group, entry.ids[0])}
          >
            x
          </ActionIcon>
        </Flex>
      ))}
      <Select
        key={entries.length}
        mt="xs"
        searchable
        placeholder={addPlaceholder}
        data={checklist.traitOptions(group)}
        value={null}
        onChange={(hex) => checklist.addTrait(group, hex)}
      />
    </Box>
  );
};

const SettingsPage = () => {
  const { t, i18n } = useTranslation();
  const [debugMode, setDebugMode] = useState(false);
  const [fullAssistUnlock, setFullAssistUnlock] = useState(false);
  const isLinux = useIsLinux();

  const {
    color_1,
    color_2,
    color_3,
    color_4,
    transparency,
    show_display_names,
    streamer_mode,
    show_full_values,
    use_condensed_skills,
    setMeterSettings,
    languages,
    handleLanguageChange,
    open_log_on_save,
    auto_check_updates,
  } = useSettings();

  const { overlayPlayer, overlaySkill } = useColumnControls();

  const checklist = useChecklistSettings();
  const { checking, checkNow } = useManualUpdateCheck();

  const { deleteAllLogs } = useLogIndexStore((state) => ({ deleteAllLogs: state.deleteAllLogs }));

  const confirmDeleteAll = () =>
    modals.openConfirmModal({
      title: "Delete logs",
      children: <Text size="sm">{t("ui.logs.delete-all-logs-confirmation")}</Text>,
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteAllLogs(),
    });

  // Dev-only: the hook reads this once when it is injected, so the checkbox reflects what
  // the NEXT game launch will do. Backend state, not store state — the value lives in a
  // file the injected hook reads, and the frontend is only a view of it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;

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

  const toggleDebugMode = () => {
    const enabled = !debugMode;
    setDebugMode(enabled);
    invoke("set_debug_mode", { enabled });
    console.info("Debug Mode:", enabled ? "Enabled" : "Disabled");
  };

  return (
    <Box>
      <Fieldset legend={t("ui.meter-settings")}>
        <Stack>
          <Select
            label={t("ui.language")}
            data={languages}
            defaultValue={i18n.language}
            allowDeselect={false}
            onChange={handleLanguageChange}
          />
          <ColorInput
            defaultValue={color_1}
            onChangeEnd={(value) => setMeterSettings({ color_1: value })}
            withEyeDropper={false}
            label={t("ui.player-1-color")}
            placeholder="Color"
          />
          <ColorInput
            defaultValue={color_2}
            onChangeEnd={(value) => setMeterSettings({ color_2: value })}
            withEyeDropper={false}
            label={t("ui.player-2-color")}
            placeholder="Color"
          />
          <ColorInput
            defaultValue={color_3}
            onChangeEnd={(value) => setMeterSettings({ color_3: value })}
            withEyeDropper={false}
            label={t("ui.player-3-color")}
            placeholder="Color"
          />
          <ColorInput
            defaultValue={color_4}
            onChangeEnd={(value) => setMeterSettings({ color_4: value })}
            withEyeDropper={false}
            label={t("ui.player-4-color")}
            placeholder="Color"
          />
          <Text size="sm">{t("ui.meter-transparency")}</Text>
          <Slider
            min={0}
            max={1}
            step={0.005}
            defaultValue={transparency}
            onChangeEnd={(value) => setMeterSettings({ transparency: value })}
          />
          <Checkbox
            label={t("ui.show-player-names")}
            checked={show_display_names}
            onChange={(event) => setMeterSettings({ show_display_names: event.currentTarget.checked })}
          />
          <Tooltip label={t("ui.streamer-mode-description")}>
            <Checkbox
              label={t("ui.streamer-mode")}
              checked={streamer_mode}
              onChange={(event) => setMeterSettings({ streamer_mode: event.currentTarget.checked })}
            />
          </Tooltip>
          <Tooltip label={t("ui.show-full-values-description")}>
            <Checkbox
              label={t("ui.show-full-values")}
              checked={show_full_values}
              onChange={(event) => setMeterSettings({ show_full_values: event.currentTarget.checked })}
            />
          </Tooltip>
          <Tooltip label={t("ui.use-condensed-skills-description")}>
            <Checkbox
              label={t("ui.use-condensed-skills")}
              checked={use_condensed_skills}
              onChange={(event) => setMeterSettings({ use_condensed_skills: event.currentTarget.checked })}
            />
          </Tooltip>
          <Tooltip label={t("ui.open-log-on-save-description")}>
            <Checkbox
              label={t("ui.open-log-on-save")}
              checked={open_log_on_save}
              onChange={(event) => setMeterSettings({ open_log_on_save: event.currentTarget.checked })}
            />
          </Tooltip>
          <Group gap="sm">
            <Tooltip label={t("ui.auto-check-updates-description")}>
              <Checkbox
                label={t("ui.auto-check-updates")}
                checked={auto_check_updates}
                onChange={(event) => setMeterSettings({ auto_check_updates: event.currentTarget.checked })}
              />
            </Tooltip>
            <Button size="compact-sm" variant="light" onClick={checkNow} loading={checking}>
              {t("ui.check-updates")}
            </Button>
          </Group>
          <Tooltip label={t("ui.debug-mode-description")}>
            <Checkbox label={t("ui.debug-mode")} checked={debugMode} onChange={toggleDebugMode} />
          </Tooltip>
          <Divider />
          <Text size="md" fw={700}>
            {t("ui.overlay-columns-section")}
          </Text>
          <ColumnEditor
            title={t("ui.player-row")}
            droppableId="overlay-player-columns"
            translationPrefix="ui.meter-columns"
            items={overlayPlayer.items}
            onToggle={overlayPlayer.onToggle}
            onReorder={overlayPlayer.onReorder}
          />
          <ColumnEditor
            title={t("ui.skill-breakdown")}
            droppableId="overlay-skill-columns"
            translationPrefix="ui.skill-columns"
            items={overlaySkill.items}
            onToggle={overlaySkill.onToggle}
            onReorder={overlaySkill.onReorder}
          />
        </Stack>
      </Fieldset>
      <Fieldset legend={t("ui.checklist-settings.title")} mt="md">
        <Stack>
          <ChecklistSection
            group="build"
            legend={t("ui.checklist-settings.sigils-section")}
            addPlaceholder={t("ui.checklist-settings.add-trait")}
            checklist={checklist}
          />
          <ChecklistSection
            group="ai"
            legend={t("ui.checklist-settings.ai-section")}
            addPlaceholder={t("ui.checklist-settings.add-trait")}
            checklist={checklist}
          />
          <Button variant="default" onClick={checklist.reset}>
            {t("ui.checklist-settings.reset")}
          </Button>
        </Stack>
      </Fieldset>
      <Fieldset legend={t("ui.logs-tab")} mt="md">
        <Box>
          <Button variant="default" onClick={confirmDeleteAll}>
            {t("ui.logs.delete-all-btn")}
          </Button>
        </Box>
      </Fieldset>
      {isLinux && <LinuxSetupSection />}
      {import.meta.env.DEV && (
        <Fieldset legend={t("ui.dev-settings")} mt="md">
          <Tooltip label={t("ui.full-assist-unlock-description")}>
            <Checkbox label={t("ui.full-assist-unlock")} checked={fullAssistUnlock} onChange={toggleFullAssistUnlock} />
          </Tooltip>
        </Fieldset>
      )}
    </Box>
  );
};

export default SettingsPage;
