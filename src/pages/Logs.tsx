import { useMeterFilterSync } from "@/stores/useMeterFilterSync";
import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import { NavTabKey, tabKeyForPath, targetFor, useNavMemoryStore } from "@/stores/useNavMemoryStore";
import "./Logs.css";

import HookStatusBadge from "@/components/HookStatusBadge";
import NewChip from "@/components/NewChip";
import UpdateAvailableButton from "@/components/UpdateAvailableButton";
import { sectionNewIds } from "@/newFeatures";
import { useIsLinux } from "@/platform";
import { deriveNavState } from "@/utils";
import { ActionIcon, AppShell, Button, Group, Text } from "@mantine/core";
import { Bug, Flag, Gear, House, ListDashes, Translate, Wrench } from "@phosphor-icons/react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/shell";
import { useEffect, useRef, useState } from "react";
import { Toaster } from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { TOOLS, visibleTools } from "./Toolbox";

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
  // Mounted here and nowhere else: the logs window always exists, and a second
  // mounting site would push the same value twice per toggle — each push makes
  // the live parser replay its event log.
  useMeterFilterSync();
  const { t } = useTranslation();
  const isLinux = useIsLinux();
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
  const { pathname, search } = useLocation();
  const { logsActive, toolboxActive, settingsActive, debugActive, confluxActive, questsActive, onListPage } =
    deriveNavState(pathname);

  // Each header tab returns to the page it was left on — the quest detail, the
  // settings section, the tool — instead of restarting at its section root.
  const rememberLocation = useNavMemoryStore((state) => state.remember);
  const navLocations = useNavMemoryStore((state) => state.locations);
  const activeTab = tabKeyForPath(pathname);
  const tabTarget = (key: NavTabKey) => targetFor(navLocations, key, activeTab);

  useEffect(() => {
    rememberLocation(pathname, search);
  }, [pathname, search, rememberLocation]);
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
              {/* eslint-disable-next-line i18next/no-literal-string -- app name, never translated */}
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
              <NavTab to={tabTarget("logs")} icon={<ListDashes size="1rem" />} active={logsActive}>
                {t("ui.logs-tab")}
              </NavTab>
              <NavTab to={tabTarget("toolbox")} icon={<Wrench size="1rem" />} active={toolboxActive}>
                <Group gap={6} wrap="nowrap">
                  {t("ui.toolbox.title")}
                  <NewChip id={sectionNewIds("toolbox", visibleTools(TOOLS, isLinux))} />
                </Group>
              </NavTab>
              <NavTab to={tabTarget("settings")} icon={<Gear size="1rem" />} active={settingsActive}>
                {t("ui.settings")}
              </NavTab>
              {import.meta.env.DEV && (
                <NavTab to={tabTarget("debug")} icon={<Bug size="1rem" />} active={debugActive}>
                  {t("ui.debug.title")}
                </NavTab>
              )}
            </Group>
            {/* minWidth: 0 lets the hook-status badge truncate here instead of
                pushing the nav tabs out of the header when space is tight. */}
            <Group gap="xs" wrap="nowrap" justify="flex-end" style={{ flex: 1, minWidth: 0 }}>
              <HookStatusBadge />
              <ActionIcon
                variant="subtle"
                color="gray"
                size="lg"
                title={t("ui.submit-missing-label")}
                aria-label={t("ui.submit-missing-label")}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=translation.yml`)}
              >
                <Translate size="1rem" />
              </ActionIcon>
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
                {t("ui.logs.quests-tab")}
              </NavTab>
              <NavTab to="/logs/conflux" icon={<Flag size="1rem" />} active={confluxActive}>
                {t("ui.logs.conflux-tab")}
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
