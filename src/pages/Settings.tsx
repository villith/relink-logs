import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { translateTraitId } from "@/utils";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  ColorInput,
  Divider,
  Fieldset,
  Flex,
  Menu,
  NumberInput,
  Select,
  Slider,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { DotsSixVertical } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
    overlay_columns,
    handleReorderOverlayColumns,
    availableOverlayColumns,
    addOverlayColumn,
    removeOverlayColumn,
    open_log_on_save,
  } = useSettings();

  const checklist = useChecklistSettings();

  const { deleteAllLogs } = useLogIndexStore((state) => ({ deleteAllLogs: state.deleteAllLogs }));

  const confirmDeleteAll = () =>
    modals.openConfirmModal({
      title: "Delete logs",
      children: <Text size="sm">{t("ui.logs.delete-all-logs-confirmation")}</Text>,
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteAllLogs(),
    });

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
          <Tooltip label={t("ui.debug-mode-description")}>
            <Checkbox label={t("ui.debug-mode")} checked={debugMode} onChange={toggleDebugMode} />
          </Tooltip>
          <Divider />
          <Text size="sm">Customize Overlay Meter Columns</Text>
          <Menu shadow="md" trigger="hover" openDelay={100} closeDelay={400}>
            <Menu.Target>
              <Button>Add column</Button>
            </Menu.Target>
            <Menu.Dropdown>
              {availableOverlayColumns.map((item) => (
                <Menu.Item key={item} onClick={() => addOverlayColumn(item)}>
                  {t(`ui.meter-columns.${item}`)} - {t(`ui.meter-columns.${item}-description`)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <DragDropContext onDragEnd={handleReorderOverlayColumns}>
            <Droppable droppableId="overlay-columns">
              {(droppableProvided) => (
                <Stack ref={droppableProvided.innerRef}>
                  {overlay_columns.map((item, index) => (
                    <Draggable key={item} draggableId={item} index={index}>
                      {(draggableProvided) => (
                        <Box
                          bg="var(--mantine-color-dark-8)"
                          display="flex"
                          p={10}
                          ref={draggableProvided.innerRef}
                          {...draggableProvided.draggableProps}
                          {...draggableProvided.dragHandleProps}
                        >
                          <Flex align="center" flex={1}>
                            <DotsSixVertical size={16} style={{ cursor: "grab", marginRight: "0.5em" }} />
                            {t(`ui.meter-columns.${item}`)} - {t(`ui.meter-columns.${item}-description`)}
                          </Flex>
                          <Flex align="center">
                            <ActionIcon
                              aria-label="Remove column"
                              variant="transparent"
                              color="gray"
                              onClick={() => removeOverlayColumn(item)}
                            >
                              x
                            </ActionIcon>
                          </Flex>
                        </Box>
                      )}
                    </Draggable>
                  ))}
                  {droppableProvided.placeholder}
                </Stack>
              )}
            </Droppable>
          </DragDropContext>
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
      <Fieldset legend="Logs" mt="md">
        <Box>
          <Button variant="default" onClick={confirmDeleteAll}>
            {t("ui.logs.delete-all-btn")}
          </Button>
        </Box>
      </Fieldset>
    </Box>
  );
};

export default SettingsPage;
