import { Alert, Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The shell every Toolbox tool opens with: the outer stack, the title, and
 * the status banners — which banners exist, what colour they are, and the
 * order they stack in.
 *
 * Banner text is passed in already translated rather than derived from a key
 * prefix: each tool words "the game isn't running" and "the RNG can't be
 * predicted" for itself, and what counts as unpredictable differs (a live
 * status flag, a returned prediction, or both). Pass null to hide a banner.
 */
const ToolPage = ({
  title,
  gameNotRunning,
  unpredictable,
  error,
  stale,
  children,
}: {
  title: string;
  gameNotRunning: string | null;
  unpredictable: string | null;
  error: string | null;
  stale: boolean;
  children: React.ReactNode;
}) => {
  const { t } = useTranslation();
  return (
    <Stack gap="md" pr="md">
      <Title order={4}>{title}</Title>
      {gameNotRunning && <Alert color="yellow">{gameNotRunning}</Alert>}
      {unpredictable && <Alert color="orange">{unpredictable}</Alert>}
      {error && <Alert color="red">{error}</Alert>}
      {stale && <Alert color="orange">{t("ui.toolbox.stale-results")}</Alert>}
      {children}
    </Stack>
  );
};

export default ToolPage;
