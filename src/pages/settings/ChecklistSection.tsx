import useChecklistSettings from "@/pages/useChecklistSettings";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { orderedChecklistEntries, translateTraitId } from "@/utils";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import { ActionIcon, Box, Checkbox, Flex, List, NumberInput, Select, Text } from "@mantine/core";
import { DotsSixVertical, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

/** The derived rows the computed group stands for, in render order. Their labels
 * are the same keys the Builds tab uses for the equivalent rows. */
const COMPUTED_ROWS = ["ui.checklist.basic-sigils", "ui.checklist.attack-sigils", "ui.checklist.defense-support-sigils"];

/**
 * One group's entry list. A custom group renders draggable, editable rows plus a
 * trait picker; the computed group renders its three fixed rows and nothing else,
 * since its criteria are derived from the equipped sigils rather than configured.
 */
export const ChecklistSection = ({
  group,
  addPlaceholder,
  checklist,
}: {
  group: ChecklistGroup;
  addPlaceholder: string;
  checklist: ReturnType<typeof useChecklistSettings>;
}) => {
  const { t } = useTranslation();

  if (group.kind === "computed") {
    return (
      <List size="sm" withPadding c="dimmed">
        {COMPUTED_ROWS.map((key) => (
          <List.Item key={key}>{t(key)}</List.Item>
        ))}
      </List>
    );
  }

  const entries = orderedChecklistEntries(group.entries, group.manualOrder);

  return (
    <Box>
      <Droppable droppableId={group.id} type="entry">
        {(droppableProvided) => (
          <Box ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
            {entries.map((entry, index) => (
              <Draggable key={entry.ids[0]} draggableId={`${group.id}::${entry.ids[0]}`} index={index}>
                {(draggableProvided) => (
                  <Flex
                    ref={draggableProvided.innerRef}
                    {...draggableProvided.draggableProps}
                    align="center"
                    gap="xs"
                    mt={4}
                    style={draggableProvided.draggableProps.style}
                  >
                    <Box
                      component="span"
                      aria-label={t("ui.checklist-settings.reorder-entry", "Reorder entry")}
                      style={{ cursor: "grab", display: "flex", color: "var(--mantine-color-dark-2)" }}
                      {...draggableProvided.dragHandleProps}
                    >
                      <DotsSixVertical size={16} />
                    </Box>
                    <Checkbox checked={entry.enabled} onChange={() => checklist.toggle(group.id, entry.ids[0])} />
                    <Text size="sm" flex={1}>
                      {translateTraitId(entry.ids[0])}
                    </Text>
                    <NumberInput
                      value={entry.level}
                      min={1}
                      step={1}
                      w={90}
                      onChange={(value) => checklist.setEntryLevel(group.id, entry.ids[0], value)}
                    />
                    <ActionIcon
                      aria-label={t("ui.delete-btn")}
                      variant="transparent"
                      color="gray"
                      onClick={() => checklist.remove(group.id, entry.ids[0])}
                    >
                      <X size={16} />
                    </ActionIcon>
                  </Flex>
                )}
              </Draggable>
            ))}
            {droppableProvided.placeholder}
          </Box>
        )}
      </Droppable>
      <Select
        key={group.entries.length}
        mt="xs"
        searchable
        placeholder={addPlaceholder}
        data={checklist.traitOptions(group.id)}
        value={null}
        onChange={(hex) => checklist.addTrait(group.id, hex)}
      />
    </Box>
  );
};

export default ChecklistSection;
