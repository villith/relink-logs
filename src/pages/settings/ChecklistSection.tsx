import useChecklistSettings from "@/pages/useChecklistSettings";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { COMPUTED_SIGIL_ROWS, SIGIL_CATEGORY_TARGET, orderedChecklistEntries, translateTraitId } from "@/utils";
import { Draggable, Droppable } from "@hello-pangea/dnd";
import { ActionIcon, Box, Checkbox, Flex, NumberInput, Select, Text } from "@mantine/core";
import { DotsSixVertical, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

/** The grab handle. Rendered for every row so the lists line up; only a
 * draggable row actually takes hold of it. */
const DragHandle = ({ label, dragHandleProps }: { label: string; dragHandleProps?: object }) => (
  <Box
    component="span"
    aria-label={dragHandleProps ? label : undefined}
    style={{
      cursor: dragHandleProps ? "grab" : "default",
      display: "flex",
      color: "var(--mantine-color-dark-2)",
      opacity: dragHandleProps ? 1 : 0.35,
    }}
    {...dragHandleProps}
  >
    <DotsSixVertical size={16} />
  </Box>
);

/** One row: toggle, name, target level, remove. The computed group renders the
 * same shape with every control disabled, so the two kinds of group read as one
 * list rather than two unrelated widgets. */
const EntryRow = ({
  label,
  level,
  enabled,
  disabled,
  handle,
  onToggle,
  onLevelChange,
  onRemove,
  removeLabel,
}: {
  label: string;
  level: number;
  enabled: boolean;
  disabled?: boolean;
  handle: React.ReactNode;
  onToggle?: () => void;
  onLevelChange?: (value: number | string) => void;
  onRemove?: () => void;
  removeLabel: string;
}) => (
  <>
    {handle}
    <Checkbox checked={enabled} disabled={disabled} onChange={() => onToggle?.()} />
    <Text size="sm" flex={1} c={disabled ? "dimmed" : undefined}>
      {label}
    </Text>
    <NumberInput
      value={level}
      min={1}
      step={1}
      w={90}
      disabled={disabled}
      onChange={(value) => onLevelChange?.(value)}
    />
    <ActionIcon
      aria-label={removeLabel}
      variant="transparent"
      color="gray"
      disabled={disabled}
      onClick={() => onRemove?.()}
    >
      <X size={16} />
    </ActionIcon>
  </>
);

/**
 * One group's entry list. A custom group renders draggable, editable rows plus a
 * trait picker; the computed group renders the same rows and picker with every
 * control disabled, since its criteria are derived from the equipped sigils
 * rather than configured.
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
  const handleLabel = t("ui.checklist-settings.reorder-entry", "Reorder entry");
  const removeLabel = t("ui.delete-btn");

  if (group.kind === "computed") {
    return (
      <Box pl="md">
        {COMPUTED_SIGIL_ROWS.map(({ label }) => (
          <Flex key={label} align="center" gap="xs" mt={4}>
            <EntryRow
              label={t(label)}
              level={SIGIL_CATEGORY_TARGET}
              enabled
              disabled
              handle={<DragHandle label={handleLabel} />}
              removeLabel={removeLabel}
            />
          </Flex>
        ))}
        <Select mt="xs" disabled placeholder={addPlaceholder} data={[]} value={null} />
      </Box>
    );
  }

  const entries = orderedChecklistEntries(group.entries, group.manualOrder);

  return (
    // Indented so the rows read as belonging to the header band above them.
    <Box pl="md">
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
                    <EntryRow
                      label={translateTraitId(entry.ids[0])}
                      level={entry.level}
                      enabled={entry.enabled}
                      handle={
                        <DragHandle label={handleLabel} dragHandleProps={draggableProvided.dragHandleProps ?? {}} />
                      }
                      onToggle={() => checklist.toggle(group.id, entry.ids[0])}
                      onLevelChange={(value) => checklist.setEntryLevel(group.id, entry.ids[0], value)}
                      onRemove={() => checklist.remove(group.id, entry.ids[0])}
                      removeLabel={removeLabel}
                    />
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
