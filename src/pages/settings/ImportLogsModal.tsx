import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useLogLibraryStore } from "@/stores/useLogLibraryStore";
import { ImportAnalysis, ImportLogExample, ImportProgress, ImportSummary } from "@/types";
import { epochToLocalTime, millisecondsToElapsedFormat, translateQuestId } from "@/utils";
import { Button, Card, Divider, Group, Progress, Stack, Table, Text, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import DbFilePicker from "./DbFilePicker";
import "./ImportLogsModal.css";

const MODAL_ID = "import-logs";

/** Settings → General's "Import Logs…" flow: pick another installation's
 * logs.db, show what its logs actually contain (a dry-run analysis of every
 * encounter in the file), then import on confirmation. */
export const openImportLogsModal = (title: string) =>
  modals.open({
    modalId: MODAL_ID,
    title,
    size: "lg",
    children: <ImportLogsModal />,
  });

const ImportLogsModal = () => {
  const { t } = useTranslation();
  const fetchLogs = useLogIndexStore((state) => state.fetchLogs);
  const [path, setPath] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysis | null>(null);
  const [picking, setPicking] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  // Both backend passes over the source file report through the same event;
  // which pass is running is already known from `analyzing`/`importing`.
  // Cleanup must unlisten (Tauri v1 listeners otherwise outlive the modal).
  useEffect(() => {
    const unlisten = listen<ImportProgress>("import-progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Picking a file immediately dry-runs the analysis.
  const pickFile = async () => {
    setPicking(true);
    try {
      const picked = await invoke<string | null>("pick_logs_db_file");
      if (!picked) return;
      setPath(picked);
      setAnalysis(null);
      setAnalyzing(true);
      setProgress(null);
      const report = await invoke<ImportAnalysis>("analyze_logs_db", { path: picked });
      setAnalysis(report);
    } catch (e) {
      toast.error(t("ui.import-logs-error", { error: String(e) }));
    } finally {
      setPicking(false);
      setAnalyzing(false);
      setProgress(null);
    }
  };

  const runImport = async () => {
    if (!path) return;
    setImporting(true);
    setProgress(null);
    try {
      const summary = await invoke<ImportSummary>("import_logs_from_file", { path });
      toast.success(t("ui.import-logs-result", { ...summary }));
      if (summary.imported > 0) {
        useLogLibraryStore.getState().invalidate();
        fetchLogs();
      }
      modals.close(MODAL_ID);
    } catch (e) {
      toast.error(t("ui.import-logs-error", { error: String(e) }));
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const busy = analyzing || importing;

  return (
    <Stack gap="sm">
      <Text size="sm">{t("ui.import-logs-modal.intro")}</Text>
      <DbFilePicker
        path={path}
        placeholder={t("ui.import-logs-modal.no-file")}
        browseLabel={t("ui.import-logs-modal.browse-btn")}
        onBrowse={pickFile}
        disabled={picking || importing}
      />
      {analyzing && (
        <ProgressSection
          progress={progress}
          busyKey="ui.import-logs-modal.processing"
          progressKey="ui.import-logs-modal.progress"
        />
      )}
      {analysis && (
        <>
          <SummaryLedger analysis={analysis} />
          {analysis.importable > 0 ? (
            <CoverageTable analysis={analysis} />
          ) : (
            <Text size="sm">{t("ui.import-logs-modal.nothing-new")}</Text>
          )}
        </>
      )}
      {importing && (
        <ProgressSection
          progress={progress}
          busyKey="ui.import-logs-modal.importing"
          progressKey="ui.import-logs-modal.importing-progress"
        />
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={() => modals.close(MODAL_ID)}>
          {t("ui.cancel-btn")}
        </Button>
        <Button onClick={runImport} loading={busy} disabled={picking || !analysis || analysis.importable === 0}>
          {analysis
            ? t("ui.import-logs-modal.import-btn", { count: analysis.importable })
            : t("ui.import-logs-modal.import-btn-empty")}
        </Button>
      </Group>
    </Stack>
  );
};

/** A labelled progress bar for one backend pass over the source file. Shows a
 * bare "working" label until the first progress event lands, then the counts. */
const ProgressSection = ({
  progress,
  busyKey,
  progressKey,
}: {
  progress: ImportProgress | null;
  /** Label before the first progress event arrives. */
  busyKey: string;
  /** Label once counts are known; interpolates `processed` and `total`. */
  progressKey: string;
}) => {
  const { t } = useTranslation();

  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {progress ? t(progressKey, { processed: progress.processed, total: progress.total }) : t(busyKey)}
      </Text>
      <Progress value={progress && progress.total > 0 ? (progress.processed / progress.total) * 100 : 0} animated />
    </Stack>
  );
};

/** The file's rows classified the way the import will treat them, drawn as a
 * little ledger: total at the top, each skipped class subtracted, the count
 * that will actually import at the bottom. Hovering a line shows up to five
 * of the rows it counted. */
const SummaryLedger = ({ analysis }: { analysis: ImportAnalysis }) => {
  const { t } = useTranslation();

  return (
    <Card withBorder padding="sm">
      <Stack gap={2}>
        <SummaryLine label={t("ui.import-logs-modal.summary-total")} amount={analysis.total} />
        <SummaryLine
          label={t("ui.import-logs-modal.summary-duplicates")}
          amount={analysis.duplicates}
          deduction
          examples={analysis.examples.duplicates}
        />
        <SummaryLine
          label={t("ui.import-logs-modal.summary-unreadable")}
          amount={analysis.unreadable}
          deduction
          examples={analysis.examples.unreadable}
        />
        <SummaryLine
          label={t("ui.import-logs-modal.summary-filtered")}
          amount={analysis.filtered}
          deduction
          examples={analysis.examples.filtered}
        />
        <Divider my={4} />
        <SummaryLine
          label={t("ui.import-logs-modal.summary-importable")}
          amount={analysis.importable}
          examples={analysis.examples.importable}
          bold
        />
      </Stack>
    </Card>
  );
};

/** One line item: label on the left, amount right-aligned in its own column,
 * deductions signed. Hovering shows the rows it counted, when there are any. */
const SummaryLine = ({
  label,
  amount,
  deduction,
  bold,
  examples,
}: {
  label: string;
  amount: number;
  deduction?: boolean;
  bold?: boolean;
  examples?: ImportLogExample[];
}) => {
  const fw = bold ? 700 : undefined;
  const hoverable = !!examples && examples.length > 0;
  const line = (
    <Group justify="space-between" gap="lg" wrap="nowrap" className={hoverable ? "import-summary-line" : undefined}>
      <Text size="sm" fw={fw}>
        {label}
      </Text>
      <Text size="sm" fw={fw} style={{ fontVariantNumeric: "tabular-nums" }}>
        {deduction && amount > 0 ? `−${amount}` : amount}
      </Text>
    </Group>
  );
  if (!hoverable) return line;

  return (
    <Tooltip color="dark" position="right" label={<ExamplesTable examples={examples} total={amount} />}>
      {line}
    </Tooltip>
  );
};

/** Up to five affected rows, as a date/duration/quest table, with a "+X more"
 * footer when the classification counted more rows (`total`) than the backend
 * kept as examples. Cells never wrap — the tooltip grows to fit the table
 * instead of clipping it. */
const ExamplesTable = ({ examples, total }: { examples: ImportLogExample[]; total: number }) => {
  const { t } = useTranslation();
  const more = total - examples.length;

  return (
    <Table
      withRowBorders={false}
      verticalSpacing={2}
      horizontalSpacing="xs"
      c="white"
      style={{ whiteSpace: "nowrap", width: "max-content" }}
    >
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("ui.logs.date")}</Table.Th>
          <Table.Th>{t("ui.logs.duration")}</Table.Th>
          <Table.Th>{t("ui.logs.quest-name")}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {examples.map((example, index) => (
          <Table.Tr key={index}>
            <Table.Td>{epochToLocalTime(example.time)}</Table.Td>
            <Table.Td>{millisecondsToElapsedFormat(example.duration)}</Table.Td>
            {/* eslint-disable-next-line i18next/no-literal-string -- bare dash for "no quest recorded" */}
            <Table.Td>{example.questId === null ? "-" : translateQuestId(example.questId)}</Table.Td>
          </Table.Tr>
        ))}
        {more > 0 && (
          <Table.Tr>
            <Table.Td colSpan={3} c="dimmed">
              {t("ui.import-logs-modal.more-examples", { count: more })}
            </Table.Td>
          </Table.Tr>
        )}
      </Table.Tbody>
    </Table>
  );
};

/** What the selected file's importable logs actually contain, one row per data
 * category the app can display. */
const CoverageTable = ({ analysis }: { analysis: ImportAnalysis }) => {
  const { t } = useTranslation();
  const total = analysis.importable;

  // How many of the importable logs carry the category; the count decides the
  // wording, so a category the source never recorded plainly reads as absent.
  const availability = (count: number) => {
    if (count === 0) return { label: t("ui.import-logs-modal.missing"), dimmed: true };
    if (count === total) return { label: t("ui.import-logs-modal.all-logs"), dimmed: false };
    return { label: t("ui.import-logs-modal.some-logs", { count, total }), dimmed: false };
  };

  const rows: Array<{ key: string; count: number }> = [
    { key: "row-damage", count: total },
    { key: "row-meta", count: total },
    { key: "row-quest", count: analysis.withQuest },
    { key: "row-party", count: analysis.withPartyNames },
    { key: "row-equipment", count: analysis.withEquipment },
    { key: "row-hp", count: analysis.withEnemyHp },
    { key: "row-overcap", count: analysis.withOvercap },
    { key: "row-deaths", count: analysis.withDeaths },
    { key: "row-stun", count: analysis.withStunEvents },
    { key: "row-sba", count: analysis.withSbaEvents },
    { key: "row-igt", count: analysis.withQuestTime },
  ];

  return (
    <Table withTableBorder striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t("ui.import-logs-modal.col-data")}</Table.Th>
          <Table.Th>{t("ui.import-logs-modal.col-availability")}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ key, count }) => {
          const { label, dimmed } = availability(count);
          return (
            <Table.Tr key={key}>
              <Table.Td>
                <Text size="xs">{t(`ui.import-logs-modal.${key}`)}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c={dimmed ? "dimmed" : undefined}>
                  {label}
                </Text>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
};
