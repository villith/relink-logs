import CollapsibleNavRail from "@/components/CollapsibleNavRail";
import { NewFeatureId } from "@/newFeatures";
import { useIsLinux } from "@/platform";
import { Box, Flex } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { Flask, MagicWand, Sparkle } from "@phosphor-icons/react";
// `Icon` is a type-only export — a value import survives today only because
// esbuild elides it, and would break under verbatimModuleSyntax.
import type { Icon } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

/** The tools in the side menu. `newId` (optional) keys into NEW_FEATURES. */
export const TOOLS: {
  to: string;
  labelKey: string;
  labelFallback: string;
  icon: Icon;
  newId?: NewFeatureId;
  windowsOnly?: boolean;
}[] = [
  {
    to: "/logs/toolbox/synthesis",
    labelKey: "ui.toolbox.synthesis-helper",
    labelFallback: "Synthesis Helper",
    icon: Flask,
  },
  {
    to: "/logs/toolbox/overmastery",
    labelKey: "ui.toolbox.overmastery-predictor",
    labelFallback: "Overmastery Predictor",
    icon: Sparkle,
    newId: "overmastery-predictor",
  },
  {
    to: "/logs/toolbox/transmarvel",
    labelKey: "ui.toolbox.transmarvel-wishlist",
    labelFallback: "Transmarvel Wishlist",
    icon: MagicWand,
    newId: "transmarvel-wishlist",
  },
];

/** Tools visible on this platform. All current tools are served by the hook
 * over the toolbox RPC channel and work everywhere; the mechanism stays for
 * any future platform-gated tool. */
export const visibleTools = <T extends { windowsOnly?: boolean }>(tools: T[], isLinux: boolean): T[] =>
  tools.filter((tool) => !(isLinux && tool.windowsOnly));

/** Every feature the Toolbox tab stands for: the toolbox itself plus the tools
 * reachable inside it. The tab is the only "New" marker visible before opening
 * the toolbox, so a newly shipped *tool* has to light it up too — the toolbox's
 * own window expires long before the tools added later do. */
export const toolboxNewIds = <T extends { newId?: NewFeatureId; windowsOnly?: boolean }>(
  tools: T[],
  isLinux: boolean
): NewFeatureId[] => ["toolbox", ...visibleTools(tools, isLinux).flatMap(({ newId }) => (newId ? [newId] : []))];

/** Toolbox: collapsible tool menu on the left, the selected tool on the right. */
const ToolboxPage = () => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useLocalStorage({ key: "toolbox-menu-collapsed", defaultValue: false });
  const isLinux = useIsLinux();
  const items = visibleTools(TOOLS, isLinux).map(({ to, labelKey, labelFallback, icon, newId }) => ({
    to,
    label: t(labelKey, labelFallback),
    icon,
    newId,
  }));

  return (
    <Flex gap="md" align="flex-start">
      <CollapsibleNavRail
        items={items}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        expandLabel={t("ui.toolbox.expand-menu")}
        collapseLabel={t("ui.toolbox.collapse-menu")}
      />
      <Box style={{ flexGrow: 1, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Flex>
  );
};

export default ToolboxPage;
