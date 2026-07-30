import { HEADER_TOKENS } from "@/components/Titlebar";
import useSettings from "@/pages/useSettings";
import type { HeaderSegment } from "@/stores/useMeterSettingsStore";
import { moveItem } from "@/utils";
import { ActionIcon, Button, Code, Group, Paper, Select, Stack, Switch, Text } from "@mantine/core";
import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { TemplateField } from "./TemplateField";

/** A fight in progress against a boss — the state where every token has a value. */
const SAMPLE = {
  app: "Relink Logs",
  version: "1.0.0",
  damage: "1.2b",
  dps: "45.2k",
  hpPercent: "45.2%",
  hpCurrent: "1.2b",
  hpMax: "2.6b",
  time: "02:41",
  status: "02:41",
};

/**
 * The overlay header, as an editable list of segments.
 *
 * Reorder is plain up/down buttons rather than drag-and-drop: a header holds a
 * handful of segments, and the drag library is only worth its weight on lists
 * that grow.
 */
export const HeaderSegmentsEditor = () => {
  const { t } = useTranslation();
  const { header_segments, setMeterSettings } = useSettings();

  const update = (segments: HeaderSegment[]) => setMeterSettings({ header_segments: segments });

  const patch = (index: number, changes: Partial<HeaderSegment>) =>
    update(header_segments.map((segment, i) => (i === index ? { ...segment, ...changes } : segment)));

  const add = () =>
    update([
      ...header_segments,
      // Ids only have to be unique within this list, and never leave it.
      {
        id: `seg-${header_segments.length}-${Math.random().toString(36).slice(2, 8)}`,
        side: "left",
        template: "",
        hideWhenNarrow: true,
      },
    ]);

  return (
    <Stack gap="xs">
      <Text size="md" fw={700}>
        {t("ui.header-segments-section")}
      </Text>
      <Text size="xs" c="dimmed">
        {t("ui.header-segments-description")}
      </Text>
      <Group gap={6}>
        <Text size="xs" c="dimmed">
          {t("ui.template-tokens")}
        </Text>
        {HEADER_TOKENS.map((token) => (
          <Code key={token}>{`{${token}}`}</Code>
        ))}
      </Group>
      {header_segments.map((segment, index) => (
        <Paper key={segment.id} p="xs" withBorder>
          <Group align="flex-start" gap="xs" wrap="nowrap">
            <TemplateField
              label={t("ui.header-segment-template")}
              value={segment.template}
              onChange={(template) => patch(index, { template })}
              tokens={HEADER_TOKENS}
              sample={SAMPLE}
            />
            <Select
              label={t("ui.header-segment-side")}
              w={110}
              data={[
                { value: "left", label: t("ui.header-side-left") },
                { value: "right", label: t("ui.header-side-right") },
              ]}
              value={segment.side}
              allowDeselect={false}
              onChange={(side) => side && patch(index, { side: side as HeaderSegment["side"] })}
            />
            <Switch
              mt={28}
              label={t("ui.header-segment-hide-narrow")}
              checked={segment.hideWhenNarrow}
              onChange={(event) => patch(index, { hideWhenNarrow: event.currentTarget.checked })}
            />
            <ActionIcon
              mt={28}
              variant="subtle"
              aria-label={t("ui.move-up")}
              disabled={index === 0}
              onClick={() => update(moveItem(header_segments, index, index - 1))}
            >
              <ArrowUp size={16} />
            </ActionIcon>
            <ActionIcon
              mt={28}
              variant="subtle"
              aria-label={t("ui.move-down")}
              disabled={index === header_segments.length - 1}
              onClick={() => update(moveItem(header_segments, index, index + 1))}
            >
              <ArrowDown size={16} />
            </ActionIcon>
            <ActionIcon
              mt={28}
              variant="subtle"
              color="red"
              aria-label={t("ui.remove")}
              onClick={() => update(header_segments.filter((_, i) => i !== index))}
            >
              <Trash size={16} />
            </ActionIcon>
          </Group>
        </Paper>
      ))}
      <Group>
        <Button variant="light" size="xs" onClick={add}>
          {t("ui.header-segment-add")}
        </Button>
      </Group>
    </Stack>
  );
};
