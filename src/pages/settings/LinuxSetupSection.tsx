import { LinuxSetupStatus } from "@/types";
import { Alert, Button, Code, CopyButton, Fieldset, Group, Loader, Stack, Text } from "@mantine/core";
import { ArrowsCounterClockwise, CheckCircle, Warning, XCircle } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const CheckRow = ({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) => (
  <Group gap="xs" wrap="nowrap">
    {ok ? (
      <CheckCircle size="1.2rem" color="var(--mantine-color-green-6)" />
    ) : warn ? (
      <Warning size="1.2rem" color="var(--mantine-color-yellow-6)" />
    ) : (
      <XCircle size="1.2rem" color="var(--mantine-color-red-6)" />
    )}
    <Text size="sm">{label}</Text>
  </Group>
);

/** Settings → Linux setup: live checks for the Proton hook-loading chain
 * (game found → proxy DLL deployed → launch options), rendered only on
 * Linux. The launch-options step cannot be probed, so it is presented as a
 * copyable instruction instead. */
export const LinuxSetupSection = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LinuxSetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    invoke<LinuxSetupStatus>("fetch_linux_setup_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const run = (command: "deploy_linux_hook" | "remove_linux_hook") =>
    invoke(command)
      .then(refresh)
      .catch((e) => setError(String(e)));

  if (!status) {
    return (
      <Fieldset legend={t("ui.linux-setup.title", "Linux setup")} mt="md">
        {error ? <Alert color="red">{error}</Alert> : <Loader size="sm" />}
      </Fieldset>
    );
  }

  const proxyLabel = {
    current: t("ui.linux-setup.proxy-current", "Hook is installed in the game folder"),
    missing: t("ui.linux-setup.proxy-missing", "Hook is not installed in the game folder"),
    outdated: t("ui.linux-setup.proxy-outdated", "Installed hook is from an older version"),
    foreign: t("ui.linux-setup.proxy-foreign", "Another tool's dinput8.dll is in the game folder — remove it first"),
  }[status.proxyStatus];

  return (
    <Fieldset legend={t("ui.linux-setup.title", "Linux setup")} mt="md">
      <Stack gap="xs">
        {error && <Alert color="red">{error}</Alert>}
        <CheckRow
          ok={status.steamFound}
          label={
            status.steamFound
              ? t("ui.linux-setup.game-found", "Game found: {{dir}}", { dir: status.gameDir })
              : t("ui.linux-setup.game-not-found", "Steam install of the game not found")
          }
        />
        <CheckRow ok={status.proxyStatus === "current"} warn={status.proxyStatus === "outdated"} label={proxyLabel} />
        <CheckRow
          ok={status.prefixFound}
          warn={!status.prefixFound}
          label={
            status.prefixFound
              ? t("ui.linux-setup.prefix-found", "Proton prefix found")
              : t("ui.linux-setup.prefix-missing", "Proton prefix not found — launch the game once via Steam")
          }
        />
        <Text size="sm" mt="xs">
          {t(
            "ui.linux-setup.launch-options-hint",
            "One-time step: paste this into Steam → Granblue Fantasy: Relink → Properties → Launch Options:"
          )}
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Code block style={{ flex: 1 }}>
            {status.launchOptions}
          </Code>
          <CopyButton value={status.launchOptions}>
            {({ copied, copy }) => (
              <Button size="compact-sm" variant="light" onClick={copy}>
                {copied ? t("ui.linux-setup.copied", "Copied") : t("ui.linux-setup.copy", "Copy")}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Group gap="xs" mt="xs">
          <Button
            size="compact-sm"
            disabled={!status.steamFound || status.proxyStatus === "current" || status.proxyStatus === "foreign"}
            onClick={() => run("deploy_linux_hook")}
          >
            {t("ui.linux-setup.deploy-btn", "Install hook")}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            disabled={!status.steamFound || status.proxyStatus === "missing" || status.proxyStatus === "foreign"}
            onClick={() => run("remove_linux_hook")}
          >
            {t("ui.linux-setup.remove-btn", "Remove hook")}
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            leftSection={<ArrowsCounterClockwise size="1rem" />}
            onClick={refresh}
          >
            {t("ui.linux-setup.refresh-btn", "Refresh")}
          </Button>
        </Group>
      </Stack>
    </Fieldset>
  );
};
