import { HEADER_TOKENS } from "@/components/Titlebar";
import { TokenField } from "@/components/tokenField/TokenField";
import { TokenPalette, TokenPaletteProvider } from "@/components/tokenField/TokenPalette";
import { usedTokens } from "@/labelTemplate";
import useSettings from "@/pages/useSettings";
import { DEFAULT_HEADER_SEGMENTS, type HeaderSegment } from "@/stores/useMeterSettingsStore";
import { moveItem } from "@/utils";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { ActionIcon, Anchor, Box, Button, Group, SegmentedControl, Stack, Text, Tooltip } from "@mantine/core";
import { ArrowsInLineHorizontal, DotsSixVertical, Trash } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

/**
 * The overlay header, as an editable list of segments.
 *
 * One compact row per segment: the format field, which side it sits on, whether
 * it survives a narrow overlay, and remove. Reorder is drag-and-drop from the
 * handle only — the same `@hello-pangea/dnd` pattern ColumnEditor uses, and
 * restricting the handle is what keeps dragging a token INTO a field from
 * picking up the whole row instead.
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

  const reset = () => update([...DEFAULT_HEADER_SEGMENTS]);

  // The header is one header split into pieces, so a token spent in any segment
  // is spent for all of them.
  const used = usedTokens(header_segments.map((segment) => segment.template));

  return (
    <TokenPaletteProvider>
      <Stack gap="xs">
        <Group justify="space-between">
          <Text size="md" fw={700}>
            {t("ui.header-segments-section")}
          </Text>
          <Anchor component="button" type="button" size="xs" onClick={reset}>
            {t("ui.reset-to-defaults")}
          </Anchor>
        </Group>
        <TokenPalette tokens={HEADER_TOKENS} used={used} />
        <DragDropContext
          onDragEnd={(result) => {
            if (!result.destination) return;
            update(moveItem(header_segments, result.source.index, result.destination.index));
          }}
        >
          <Droppable droppableId="header-segments">
            {(droppable) => (
              <Stack gap={4} ref={droppable.innerRef} {...droppable.droppableProps}>
                {header_segments.map((segment, index) => (
                  <Draggable key={segment.id} draggableId={segment.id} index={index}>
                    {(draggable) => (
                      <Group
                        ref={draggable.innerRef}
                        {...draggable.draggableProps}
                        gap="xs"
                        wrap="nowrap"
                        align="center"
                      >
                        <Box
                          {...draggable.dragHandleProps}
                          aria-label={t("ui.header-segment-reorder")}
                          style={{ cursor: "grab", display: "flex", color: "var(--mantine-color-dark-2)" }}
                        >
                          <DotsSixVertical size={16} />
                        </Box>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <TokenField
                            label={t("ui.header-segment-template")}
                            hideLabel
                            value={segment.template}
                            onChange={(template) => patch(index, { template })}
                            tokens={HEADER_TOKENS}
                            used={used}
                          />
                        </Box>
                        <SegmentedControl
                          size="xs"
                          value={segment.side}
                          onChange={(side) => patch(index, { side: side as HeaderSegment["side"] })}
                          data={[
                            { value: "left", label: t("ui.header-side-left") },
                            { value: "right", label: t("ui.header-side-right") },
                          ]}
                        />
                        <Tooltip label={t("ui.header-segment-hide-narrow")}>
                          <ActionIcon
                            variant={segment.hideWhenNarrow ? "filled" : "subtle"}
                            aria-label={t("ui.header-segment-hide-narrow")}
                            aria-pressed={segment.hideWhenNarrow}
                            onClick={() => patch(index, { hideWhenNarrow: !segment.hideWhenNarrow })}
                          >
                            <ArrowsInLineHorizontal size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t("ui.remove")}
                          onClick={() => update(header_segments.filter((_, i) => i !== index))}
                        >
                          <Trash size={16} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Draggable>
                ))}
                {droppable.placeholder}
              </Stack>
            )}
          </Droppable>
        </DragDropContext>
        <Group>
          <Button variant="light" size="xs" onClick={add}>
            {t("ui.header-segment-add")}
          </Button>
        </Group>
      </Stack>
    </TokenPaletteProvider>
  );
};
