import useChecklistSettings from "@/pages/useChecklistSettings";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { translateTraitId } from "@/utils";
import { ActionIcon, Box, Checkbox, Flex, NumberInput, Select, Text } from "@mantine/core";
import { X } from "@phosphor-icons/react";

/** One editable checklist group: a toggle + target level per entry, plus a
 * searchable picker that appends a trait the group doesn't already carry. */
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
            <X size={16} />
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

export default ChecklistSection;
