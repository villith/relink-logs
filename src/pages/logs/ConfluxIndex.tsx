import { ConfluxRoom, ConfluxRun } from "@/types";
import { epochToLocalTime, millisecondsToElapsedFormat, translateEnemyTypeId } from "@/utils";
import { Badge, Box, Button, Center, Collapse, Divider, Group, Pagination, Table, Text } from "@mantine/core";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import useConfluxIndex from "./useConfluxIndex";

function RoomRow({ room, buffIds }: { room: ConfluxRoom; buffIds: number[] }) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td />
      <Table.Td>
        <Text size="xs">{t("ui.logs.conflux-room-number", { number: room.roomIndex + 1 })}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{room.primaryTarget !== null ? translateEnemyTypeId(room.primaryTarget) : ""}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{millisecondsToElapsedFormat(room.duration)}</Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4}>
          {buffIds.map((id) => (
            <Badge key={id} size="xs" variant="light">
              {t(`conflux-buffs:${id}`, String(id))}
            </Badge>
          ))}
        </Group>
      </Table.Td>
      <Table.Td>
        <Button size="xs" variant="default" component={Link} to={`/logs/${room.logId}`}>
          {t("ui.logs.overview")}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}

function RunRow({ run }: { run: ConfluxRun }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const buffsFor = (roomIndex: number) => run.buffs.find((b) => b.roomIndex === roomIndex)?.buffIds ?? [];

  return (
    <>
      <Table.Tr style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Table.Td>{open ? <CaretDown size="1rem" /> : <CaretRight size="1rem" />}</Table.Td>
        <Table.Td>
          <Text size="xs">{epochToLocalTime(run.startTime)}</Text>
        </Table.Td>
        <Table.Td>
          <Text size="xs">{t("ui.logs.conflux-run")}</Text>
        </Table.Td>
        <Table.Td>
          <Badge size="xs" variant="light">
            {t("ui.logs.conflux-rooms-count", { count: run.roomCount })}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Text size="xs">{run.duration ? millisecondsToElapsedFormat(run.duration) : ""}</Text>
        </Table.Td>
        <Table.Td>
          {/* completed=false only means the reward screen wasn't observed (the usual
              town-exit path can't tell cleared from abandoned) — never show it as a failure. */}
          {run.completed ? (
            <Text size="xs">✓</Text>
          ) : run.endTime === null ? (
            <Text size="xs" c="dimmed">
              {t("ui.logs.in-progress")}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
        <Table.Td />
        <Table.Td />
      </Table.Tr>
      <Table.Tr>
        <Table.Td colSpan={8} style={{ padding: 0, border: open ? undefined : "none" }}>
          <Collapse in={open}>
            <Table>
              <Table.Tbody>
                {run.rooms.map((room) => (
                  <RoomRow key={room.logId} room={room} buffIds={buffsFor(room.roomIndex)} />
                ))}
              </Table.Tbody>
            </Table>
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

export const ConfluxIndexPage = () => {
  const { t } = useTranslation();
  const { result, page, setPage } = useConfluxIndex();

  return (
    <Box>
      {result.runs.length === 0 ? (
        <Center py="xl">
          <Text c="dimmed">{t("ui.logs.no-conflux-runs")}</Text>
        </Center>
      ) : (
        <Box>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th />
                <Table.Th>{t("ui.logs.date")}</Table.Th>
                <Table.Th>{t("ui.logs.type")}</Table.Th>
                <Table.Th>{t("ui.logs.rooms")}</Table.Th>
                <Table.Th>{t("ui.logs.duration")}</Table.Th>
                <Table.Th>{t("ui.logs.cleared")}</Table.Th>
                <Table.Th />
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </Table.Tbody>
          </Table>
          <Divider my="sm" />
          <Group justify="space-between">
            <Pagination total={result.pageCount} value={page} onChange={setPage} />
            <Text size="sm" c="dimmed">
              {t("ui.logs.conflux-runs-saved", { count: result.runCount })}
            </Text>
          </Group>
        </Box>
      )}
    </Box>
  );
};
