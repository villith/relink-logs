import { Box, Tabs } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { useTabParam } from "@/hooks/useTabParam";

import { CapTab } from "./debug/cap/CapTab";
import { HookTab } from "./debug/HookTab";

/** Dev-only tooling, one tab per thing being poked at. Reached from the header's
 * Bug tab, which is itself behind `import.meta.env.DEV`. */
const TABS = ["hook", "cap"] as const;

/** The viewport minus the AppShell header and its padding above and below —
 * the same expression the Cheat Audit page and the Toolbox nav rail use.
 * Bounding the page to the viewport is what lets the cap tab's hit list and
 * derivation columns fill the window and own their scrollbars. */
const PAGE_HEIGHT = "calc(100vh - var(--app-shell-header-height, 50px) - var(--mantine-spacing-sm) * 2)";

const DebugPage = () => {
  const { t } = useTranslation();
  // In the URL, so the header's per-tab memory returns to the tool that was
  // left open rather than restarting at the hook buttons.
  const [tab, setTab] = useTabParam(TABS, "hook");

  return (
    <Box p="sm" style={{ height: PAGE_HEIGHT, display: "flex", flexDirection: "column" }}>
      {/* The Tabs element and the active panel both stretch, so a tab's content
          sees the full remaining height (`minHeight: 0` at each level is what
          lets the scrollers inside shrink instead of overflowing the page). */}
      <Tabs
        value={tab}
        onChange={setTab}
        style={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        <Tabs.List mb="sm">
          <Tabs.Tab value="hook">{t("ui.debug.tab-hook")}</Tabs.Tab>
          <Tabs.Tab value="cap">{t("ui.debug.tab-cap")}</Tabs.Tab>
        </Tabs.List>
        {/* Rendered only while selected, not hidden: the cap tab fetches a whole
            log's event stream on mount, and mounting it behind the hook tab
            would pay for that every time the Debug page is opened. */}
        <Tabs.Panel value="hook" style={{ flexGrow: 1, minHeight: 0 }}>
          {tab === "hook" && <HookTab />}
        </Tabs.Panel>
        <Tabs.Panel value="cap" style={{ flexGrow: 1, minHeight: 0 }}>
          {tab === "cap" && <CapTab />}
        </Tabs.Panel>
      </Tabs>
    </Box>
  );
};

export default DebugPage;
