import useChecklistSettings from "@/pages/useChecklistSettings";
import { type ChecklistGroup } from "@/stores/useChecklistStore";
import { checklistGroupName, moveItem, orderedChecklistEntries } from "@/utils";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ActionIcon, Box, Button, Card, Checkbox, Group, Stack, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { DotsSixVertical, SortAscending, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChecklistSection } from "./ChecklistSection";

/** Settings → Checklist: the Builds-tab criteria as an ordered list of groups.
 * One DragDropContext spans both nesting levels, which is what lets an entry be
 * dragged from one group into another; the distinct droppable `type` values stop
 * a group being dropped into an entry list. */
const ChecklistSettings = () => {
  const { t } = useTranslation();
  const checklist = useChecklistSettings();
  const [editing, setEditing] = useState<string | null>(null);

  // Reads as an action while the group is manually ordered, and as the current
  // state once it is not — the same button covers both.
  const sortLabel = (group: ChecklistGroup) =>
    group.manualOrder
      ? t("ui.checklist-settings.sort-az", "Sort A-Z")
      : t("ui.checklist-settings.sorted-az", "Sorted A-Z");

  const onDragEnd = ({ source, destination, type, draggableId }: DropResult) => {
    if (!destination) return;
    if (type === "group") {
      checklist.reorderGroups(source.index, destination.index);
      return;
    }
    const firstId = Number(draggableId.split("::")[1]);
    const target = checklist.groups.find((group) => group.id === destination.droppableId);
    if (!target) return;
    // Indexes report positions in the DISPLAYED list, which in auto mode is not
    // the stored array — so send the resulting id order rather than raw indexes.
    const order = orderedChecklistEntries(target.entries, target.manualOrder).map((entry) => entry.ids[0]);
    if (source.droppableId === destination.droppableId) {
      checklist.reorderEntries(destination.droppableId, moveItem(order, source.index, destination.index));
      return;
    }
    order.splice(destination.index, 0, firstId);
    checklist.moveEntry(source.droppableId, destination.droppableId, firstId, order);
  };

  const confirmRemove = (group: ChecklistGroup) => {
    if (group.entries.length === 0) {
      checklist.removeGroup(group.id);
      return;
    }
    modals.openConfirmModal({
      title: t("ui.checklist-settings.delete-group-title", "Delete group"),
      children: t("ui.checklist-settings.delete-group-confirm", {
        name: checklistGroupName(group),
        count: group.entries.length,
      }),
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => checklist.removeGroup(group.id),
    });
  };

  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{t("ui.checklist-settings.title")}</Title>
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="checklist-groups" type="group">
          {(droppableProvided) => (
            <Stack gap="sm" ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
              {checklist.groups.map((group, index) => (
                <Draggable key={group.id} draggableId={`group::${group.id}`} index={index}>
                  {(draggableProvided) => (
                    <Card
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      withBorder
                      padding="sm"
                      style={draggableProvided.draggableProps.style}
                    >
                      {/* A bordered, tinted band: the header has the same controls as
                       * an entry row, so it needs to be separated by more than spacing. */}
                      <Card.Section
                        withBorder
                        inheritPadding
                        py="xs"
                        mb="xs"
                        bg="var(--mantine-color-dark-6)"
                      >
                        <Group gap="xs" wrap="nowrap">
                          <Box
                            component="span"
                            aria-label={t("ui.checklist-settings.reorder-group", "Reorder group")}
                            style={{ cursor: "grab", display: "flex", color: "var(--mantine-color-dark-2)" }}
                            {...draggableProvided.dragHandleProps}
                          >
                            <DotsSixVertical size={20} weight="bold" />
                          </Box>
                          <Tooltip label={t("ui.checklist-settings.group-enabled", "Show this group")}>
                            <Checkbox checked={group.enabled} onChange={() => checklist.toggleGroup(group.id)} />
                          </Tooltip>
                          {editing === group.id ? (
                            <TextInput
                              autoFocus
                              size="sm"
                              flex={1}
                              defaultValue={checklistGroupName(group)}
                              placeholder={t("ui.checklist-settings.group-name-placeholder", "Group name")}
                              onBlur={(event) => {
                                checklist.renameGroup(group.id, event.currentTarget.value);
                                setEditing(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur();
                                if (event.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <Button
                              variant="subtle"
                              color="gray"
                              size="compact-md"
                              flex={1}
                              justify="flex-start"
                              // Zero horizontal padding: a subtle Button's own inset
                              // would push the name out of line with the controls.
                              px={0}
                              title={t("ui.checklist-settings.rename-group", "Rename group")}
                              onClick={() => setEditing(group.id)}
                            >
                              <Text fw={700} size="sm" tt="uppercase">
                                {checklistGroupName(group)}
                              </Text>
                            </Button>
                          )}
                          {group.kind === "custom" && (
                            <>
                              {/* Lit green while the group is in alphabetical mode — the
                               * button reports the current ordering as much as it sets it. */}
                              <Tooltip label={sortLabel(group)}>
                                <ActionIcon
                                  variant={group.manualOrder ? "subtle" : "light"}
                                  color={group.manualOrder ? "gray" : "green"}
                                  aria-label={sortLabel(group)}
                                  onClick={() => checklist.sortGroup(group.id)}
                                >
                                  <SortAscending size={16} />
                                </ActionIcon>
                              </Tooltip>
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                aria-label={t("ui.checklist-settings.delete-group", "Delete group")}
                                onClick={() => confirmRemove(group)}
                              >
                                <Trash size={16} />
                              </ActionIcon>
                            </>
                          )}
                        </Group>
                      </Card.Section>
                      <ChecklistSection
                        group={group}
                        addPlaceholder={t("ui.checklist-settings.add-trait")}
                        checklist={checklist}
                      />
                    </Card>
                  )}
                </Draggable>
              ))}
              {droppableProvided.placeholder}
            </Stack>
          )}
        </Droppable>
      </DragDropContext>
      <Group gap="sm">
        <Button
          variant="default"
          onClick={() => setEditing(checklist.addGroup(t("ui.checklist-settings.new-group-name", "New group")))}
        >
          {t("ui.checklist-settings.new-group", "New group")}
        </Button>
        <Button variant="default" onClick={checklist.reset}>
          {t("ui.checklist-settings.reset")}
        </Button>
      </Group>
    </Stack>
  );
};

export default ChecklistSettings;
