import { DragDropContext, Draggable, Droppable, DropResult } from "@hello-pangea/dnd";
import { Box, Checkbox, Stack, Text } from "@mantine/core";
import { DotsSixVertical } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { ColumnSetting } from "@/types";

export type ColumnEditorProps = {
  /** Heading shown above the editor, e.g. "Player Row". */
  title: string;
  /** Unique dnd droppable id (must differ across editors on the page). */
  droppableId: string;
  /** i18n key prefix for column labels, e.g. "ui.meter-columns" or "ui.skill-columns". */
  translationPrefix: string;
  /** Every column of the set, in order (both shown and hidden). */
  items: ColumnSetting<string>[];
  onToggle: (id: string) => void;
  onReorder: (result: DropResult) => void;
};

/** A column chooser for one ordered column list. Each column is a draggable card
 * with a checkbox: checked = shown. Toggling a card keeps it in place (it just
 * stops rendering in the table); drag to reorder. Shared by the overlay settings
 * and the quest-details columns popover. */
export const ColumnEditor = ({ title, droppableId, translationPrefix, items, onToggle, onReorder }: ColumnEditorProps) => {
  const { t } = useTranslation();
  const label = (column: string) =>
    `${t(`${translationPrefix}.${column}`)} — ${t(`${translationPrefix}.${column}-description`)}`;

  return (
    <Stack gap={6}>
      <Text size="xs" fw={600} c="dimmed" tt="uppercase">
        {title}
      </Text>
      <DragDropContext onDragEnd={onReorder}>
        <Droppable droppableId={droppableId}>
          {(droppableProvided) => (
            <Stack gap={4} ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
              {items.map((item, index) => (
                <Draggable key={item.id} draggableId={`${droppableId}-${item.id}`} index={index}>
                  {(draggableProvided, snapshot) => (
                    <Box
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      bg="var(--mantine-color-dark-8)"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5em",
                        padding: "6px 8px",
                        borderRadius: "var(--mantine-radius-sm)",
                        boxShadow: snapshot.isDragging ? "var(--mantine-shadow-md)" : undefined,
                        ...draggableProvided.draggableProps.style,
                      }}
                    >
                      <Box
                        component="span"
                        aria-label="Reorder column"
                        style={{ cursor: "grab", display: "flex", alignItems: "center", color: "var(--mantine-color-dark-2)" }}
                        {...draggableProvided.dragHandleProps}
                      >
                        <DotsSixVertical size={16} />
                      </Box>
                      <Checkbox
                        size="xs"
                        checked={item.visible}
                        label={label(item.id)}
                        onChange={() => onToggle(item.id)}
                        styles={{ label: { opacity: item.visible ? 1 : 0.5 } }}
                      />
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
  );
};
