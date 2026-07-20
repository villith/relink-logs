import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import "./Logs.css";

import NewChip from "@/components/NewChip";
import UpdateAvailableButton from "@/components/UpdateAvailableButton";
import { deriveNavState } from "@/utils";
import { ActionIcon, AppShell, Button, Group, Text } from "@mantine/core";
import { ArrowsCounterClockwise, Bug, Flag, Gear, House, ListDashes, Translate, Wrench } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/shell";
import { useEffect, useRef, useState } from "react";
import { Toaster } from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useUpdateStatusStore } from "@/stores/useUpdateStatusStore";

import useUpdateCheck from "@/useUpdateCheck";

const GITHUB_URL = "https://github.com/villith/relink-logs";

const NavTab = ({
  to,
  icon,
  active,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  active: boolean;
  children: React.ReactNode;
}) => (
  <Button
    variant={active ? "light" : "subtle"}
    color="gray"
    size="sm"
    px="lg"
    leftSection={icon}
    component={Link}
    to={to}
    style={{
      borderBottom: active ? "3px solid var(--mantine-color-blue-5)" : "3px solid transparent",
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    }}
  >
    {children}
  </Button>
);

const Layout = () => {
  // Atomic selectors: a selector returning a fresh object literal fails
  // zustand's Object.is check on every store write, so any meter-settings
  // change (a transparency drag, the update prompt's Skip) would re-render
  // this Layout and its whole Outlet subtree.
  const open_log_on_save = useMeterSettingsStore((state) => state.open_log_on_save);
  const auto_check_updates = useMeterSettingsStore((state) => state.auto_check_updates);
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  useUpdateCheck(auto_check_updates);
  const updateStatus = useUpdateStatusStore((state) => state.status);
  const versionSuffix = !updateStatus
    ? ""
    : updateStatus.upToDate
      ? ` (${t("ui.version-latest")})`
      : // No version means the endpoint didn't name one; "update available - v"
        // would read as a bug, so fall back to the bare phrase.
        updateStatus.latestVersion
        ? ` (${t("ui.version-update-available", { version: updateStatus.latestVersion })})`
        : ` (${t("ui.version-update-available-unknown")})`;

  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { logsActive, toolboxActive, settingsActive, confluxActive, questsActive, onListPage } =
    deriveNavState(pathname);
  // Live pathname for the encounter-saved listener (its closure would
  // otherwise hold the pathname from when the listener was attached).
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  useEffect(() => {
    const debugListener = listen("debug-event", (event: { payload: unknown }) => {
      console.info(JSON.stringify(event.payload));
    });

    const saveListener = listen("encounter-saved", (event: { payload: number | null }) => {
      // Never yank the user out of the toolbox mid-task.
      if (event.payload && open_log_on_save && !deriveNavState(pathnameRef.current).toolboxActive) {
        navigate(`/logs/${event.payload}`);
      }
    });

    return () => {
      debugListener.then((f) => f());
      saveListener.then((f) => f());
    };
  }, [open_log_on_save]);

  return (
    <div className="log-window">
      <AppShell header={{ height: 50 }} padding="sm">
        <AppShell.Header>
          <Group h="100%" px="sm" gap="xs" wrap="nowrap">
            <Group h="100%" gap="sm" wrap="nowrap" style={{ flex: 1 }}>
              <Text style={{ whiteSpace: "nowrap" }}>
                Relink Logs
                {version && ` - v${version}`}
                {version && versionSuffix && (
                  <Text span c="dimmed">
                    {versionSuffix}
                  </Text>
                )}
              </Text>
              <UpdateAvailableButton />
            </Group>
            <Group h="100%" gap="xs" wrap="nowrap" justify="center">
              <NavTab to="/logs" icon={<ListDashes size="1rem" />} active={logsActive}>
                {t("ui.logs-tab")}
              </NavTab>
              <NavTab to="/logs/toolbox" icon={<Wrench size="1rem" />} active={toolboxActive}>
                <Group gap={6} wrap="nowrap">
                  {t("ui.toolbox.title")}
                  <NewChip id="toolbox" />
                </Group>
              </NavTab>
              <NavTab to="/logs/settings" icon={<Gear size="1rem" />} active={settingsActive}>
                {t("ui.settings")}
              </NavTab>
            </Group>
            <Group gap="xs" wrap="nowrap" justify="flex-end" style={{ flex: 1 }}>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<ArrowsCounterClockwise size="1rem" />}
                onClick={() => invoke("reset_meter_window")}
              >
                {t("ui.reset-overlay-layout")}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<Translate size="1rem" />}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=translation.yml`)}
              >
                {t("ui.submit-missing-label")}
              </Button>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                title={t("ui.report-bug")}
                aria-label={t("ui.report-bug")}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=bug.yml`)}
              >
                <Bug size="1rem" />
              </ActionIcon>
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Main>
          {onListPage && (
            <Group gap="xs" mb="sm" justify="center">
              <NavTab to="/logs" icon={<House size="1rem" />} active={questsActive}>
                Quests
              </NavTab>
              <NavTab to="/logs/conflux" icon={<Flag size="1rem" />} active={confluxActive}>
                Conflux
              </NavTab>
            </Group>
          )}
          <Outlet />
        </AppShell.Main>
      </AppShell>
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            borderRadius: "10px",
            backgroundColor: "#252525",
            color: "#fff",
            fontSize: "14px",
          },
        }}
      />
    </div>
  );
};

export default Layout;
