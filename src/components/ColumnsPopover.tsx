import { Box, Button, Popover, Stack } from "@mantine/core";
import { CaretDown, Columns } from "@phosphor-icons/react";

import { ColumnEditor } from "./ColumnEditor";
import { useColumnControls } from "./useColumnControls";

/** Inline column picker for the quest-details meter table: edits the main-window
 * player-row and skill-breakdown columns (persisted globally, all logs). Not
 * wrapped in a ScrollArea — @hello-pangea/dnd misbehaves inside transformed
 * scroll containers; a plain scroll box with a stable gutter is used instead. */
export const ColumnsPopover = () => {
  const { logsPlayer, logsSkill } = useColumnControls();

  return (
    <Popover width={460} position="bottom-end" shadow="md" withinPortal>
      <Popover.Target>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          leftSection={<Columns size={14} />}
          rightSection={<CaretDown size={12} />}
        >
          Columns
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Box mah={460} style={{ overflowY: "auto", scrollbarGutter: "stable" }}>
          <Stack gap="md">
            <ColumnEditor
              title="Player Row"
              droppableId="logs-player-columns"
              translationPrefix="ui.meter-columns"
              items={logsPlayer.items}
              onToggle={logsPlayer.onToggle}
              onReorder={logsPlayer.onReorder}
            />
            <ColumnEditor
              title="Skill Breakdown"
              droppableId="logs-skill-columns"
              translationPrefix="ui.skill-columns"
              items={logsSkill.items}
              onToggle={logsSkill.onToggle}
              onReorder={logsSkill.onReorder}
            />
          </Stack>
        </Box>
      </Popover.Dropdown>
    </Popover>
  );
};
