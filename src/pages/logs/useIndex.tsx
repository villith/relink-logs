import { useEncounterStore } from "@/stores/useEncounterStore";
import { useLogIndexStore } from "@/stores/useLogIndexStore";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { LogSortType } from "@/types";

import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export default function useIndex() {
  const { t } = useTranslation();

  const {
    currentPage,
    setCurrentPage,
    searchResult,
    filters,
    setFilters,
    selectedLogIds,
    setSelectedLogIds,
    deleteSelectedLogs,
    fetchLogs,
  } = useLogIndexStore((state) => ({
    currentPage: state.currentPage,
    setCurrentPage: state.setCurrentPage,
    searchResult: state.searchResult,
    filters: state.filters,
    setFilters: state.setFilters,
    selectedLogIds: state.selectedLogIds,
    setSelectedLogIds: state.setSelectedLogIds,
    deleteSelectedLogs: state.deleteSelectedLogs,
    fetchLogs: state.fetchLogs,
  }));

  const { setSelectedTargetSpans } = useEncounterStore((state) => ({
    setSelectedTargetSpans: state.setSelectedTargetSpans,
  }));

  // Read as a scalar so this subscribes to the one field, not to every meter
  // setting: the quest list re-queries when it changes.
  const show_flagged_builds = useMeterSettingsStore((state) => state.show_flagged_builds);

  // Also on the master switch: it decides whether the flagged filter reaches
  // the query at all, so flipping it has to re-ask rather than leave the list
  // filtered by a control that is no longer on screen.
  useEffect(() => {
    fetchLogs();
  }, [currentPage, filters, show_flagged_builds]);

  useEffect(() => {
    const encounterSavedListener = listen("encounter-saved", () => {
      fetchLogs();
    });

    return () => {
      encounterSavedListener.then((f) => f());
    };
  }, [currentPage, filters]);

  const confirmDeleteSelected = () =>
    modals.openConfirmModal({
      title: "Delete logs",
      children: (
        <Text size="sm">{t("ui.logs.delete-selected-logs-confirmation", { count: selectedLogIds.length })}</Text>
      ),
      labels: { confirm: t("ui.delete-btn"), cancel: t("ui.cancel-btn") },
      confirmProps: { color: "red" },
      onConfirm: () => deleteSelectedLogs(),
    });

  const handleSetPage = (page: number) => {
    setCurrentPage(page);
    setSelectedLogIds([]);
    fetchLogs();
  };

  const toggleAdvancedFilters = () => {
    setFilters({ showAdvancedFilters: !filters.showAdvancedFilters });
  };

  const toggleSort = (newSortType: LogSortType) => {
    setCurrentPage(1);

    if (filters.sortType === newSortType) {
      setFilters({ sortDirection: filters.sortDirection === "asc" ? "desc" : "asc" });
    } else {
      setFilters({ sortType: newSortType, sortDirection: "asc" });
    }
  };

  return {
    searchResult,
    selectedLogIds,
    setSelectedLogIds,
    setSelectedTargetSpans,
    confirmDeleteSelected,
    handleSetPage,
    currentPage,
    filters,
    setFilters,
    toggleAdvancedFilters,
    toggleSort,
  };
}
