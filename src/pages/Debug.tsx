import { Box, Tabs } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { useTabParam } from "@/hooks/useTabParam";

import { CapTab } from "./debug/cap/CapTab";
import { HookTab } from "./debug/HookTab";

/** Dev-only tooling, one tab per thing being poked at. Reached from the header's
 * Bug tab, which is itself behind `import.meta.env.DEV`. */
const TABS = ["hook", "cap"] as const;

const DebugPage = () => {
  const { t } = useTranslation();
  // In the URL, so the header's per-tab memory returns to the tool that was
  // left open rather than restarting at the hook buttons.
  const [tab, setTab] = useTabParam(TABS, "hook");

  return (
    <Box p="sm">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="hook">{t("ui.debug.tab-hook")}</Tabs.Tab>
          <Tabs.Tab value="cap">{t("ui.debug.tab-cap")}</Tabs.Tab>
        </Tabs.List>
        {/* Rendered only while selected, not hidden: the cap tab fetches a whole
            log's event stream on mount, and mounting it behind the hook tab
            would pay for that every time the Debug page is opened. */}
        <Tabs.Panel value="hook">{tab === "hook" && <HookTab />}</Tabs.Panel>
        <Tabs.Panel value="cap">{tab === "cap" && <CapTab />}</Tabs.Panel>
      </Tabs>
    </Box>
  );
};

export default DebugPage;
