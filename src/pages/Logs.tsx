import { useMeterSettingsStore } from "@/stores/useMeterSettingsStore";
import "./Logs.css";

import { AppShell, Burger, Button, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Bug, Flag, Gear, GithubLogo, House, Translate } from "@phosphor-icons/react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/shell";
import { useEffect } from "react";
import { Toaster } from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useNavigate } from "react-router-dom";

const GITHUB_URL = "https://github.com/villith/gbfr-logs";

const Layout = () => {
  const [mobileOpened, { toggle: toggleMobile }] = useDisclosure();
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(false);
  const { open_log_on_save } = useMeterSettingsStore((state) => ({ open_log_on_save: state.open_log_on_save }));
  const { t } = useTranslation();

  const navigate = useNavigate();

  useEffect(() => {
    const debugListener = listen("debug-event", (event: { payload: unknown }) => {
      console.info(JSON.stringify(event.payload));
    });

    const saveListener = listen("encounter-saved", (event: { payload: number | null }) => {
      if (event.payload && open_log_on_save) {
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
      <AppShell
        header={{ height: 50 }}
        navbar={{
          width: 300,
          breakpoint: "sm",
          collapsed: { mobile: !mobileOpened, desktop: !desktopOpened },
        }}
        padding="sm"
      >
        <AppShell.Header>
          <Group h="100%" px="sm" justify="space-between">
            <Group h="100%" gap="sm">
              <Burger opened={mobileOpened} onClick={toggleMobile} hiddenFrom="sm" size="sm" />
              <Burger opened={desktopOpened} onClick={toggleDesktop} visibleFrom="sm" size="sm" />
              <Text>GBFR Logs</Text>
            </Group>
            <Group gap="xs">
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<GithubLogo size="1rem" />}
                onClick={() => open(GITHUB_URL)}
              >
                {t("ui.github")}
              </Button>
              <Button
                variant="subtle"
                color="gray"
                size="compact-sm"
                leftSection={<Bug size="1rem" />}
                onClick={() => open(`${GITHUB_URL}/issues/new?template=bug.yml`)}
              >
                {t("ui.report-bug")}
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
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="sm">
          <AppShell.Section grow>
            <NavLink label="Logs" leftSection={<House size="1rem" />} component={Link} to="/logs" />
            <NavLink label="Conflux" leftSection={<Flag size="1rem" />} component={Link} to="/logs/conflux" />
          </AppShell.Section>
          <AppShell.Section>
            <NavLink label="Settings" leftSection={<Gear size="1rem" />} component={Link} to="/logs/settings" />
          </AppShell.Section>
        </AppShell.Navbar>
        <AppShell.Main>
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
