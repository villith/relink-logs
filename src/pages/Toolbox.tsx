import NewChip, { NEW_CHIP_COLOR } from "@/components/NewChip";
import { isNew, NewFeatureId } from "@/newFeatures";
import { useIsLinux } from "@/platform";
import { Box, Divider, Flex, Indicator, NavLink } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { CaretDoubleLeft, CaretDoubleRight, Flask, Sparkle } from "@phosphor-icons/react";
// `Icon` is a type-only export — a value import survives today only because
// esbuild elides it, and would break under verbatimModuleSyntax.
import type { Icon } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router-dom";

/** The tools in the side menu. `newId` (optional) keys into NEW_FEATURES. */
const TOOLS: {
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
];

/** Tools visible on this platform. All current tools are served by the hook
 * over the toolbox RPC channel and work everywhere; the mechanism stays for
 * any future platform-gated tool. */
export const visibleTools = <T extends { windowsOnly?: boolean }>(tools: T[], isLinux: boolean): T[] =>
  tools.filter((tool) => !(isLinux && tool.windowsOnly));

/** Toolbox: collapsible tool menu on the left (icon-only when collapsed,
 * with a chip-colored dot standing in for a visible "New" chip), the
 * selected tool on the right. */
const ToolboxPage = () => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useLocalStorage({ key: "toolbox-menu-collapsed", defaultValue: false });
  const isLinux = useIsLinux();
  const tools = visibleTools(TOOLS, isLinux);

  // Hard-fixed row height: the label's line box (~40.8px row) vs icon-only
  // (40px row) would otherwise shift everything a fraction on collapse.
  const rowStyles = {
    root: { height: 42 },
    body: collapsed ? { display: "none" as const } : undefined,
  };
  const toggleLabel = t(collapsed ? "ui.toolbox.expand-menu" : "ui.toolbox.collapse-menu");

  return (
    <Flex gap="md" align="flex-start">
      <Box w={collapsed ? 56 : 300} style={{ flexShrink: 0 }}>
        {tools.map(({ to, labelKey, labelFallback, icon: ToolIcon, newId }) => {
          const label = t(labelKey, labelFallback);
          return (
            <NavLink
              key={to}
              component={Link}
              to={to}
              label={collapsed ? undefined : label}
              title={collapsed ? label : undefined}
              leftSection={
                <Indicator color={NEW_CHIP_COLOR} size={8} offset={1} disabled={!collapsed || !newId || !isNew(newId)}>
                  <ToolIcon size="1.5rem" style={{ display: "block" }} />
                </Indicator>
              }
              rightSection={collapsed ? undefined : <NewChip id={newId} />}
              active={pathname.startsWith(to)}
              styles={rowStyles}
            />
          );
        })}
        <Divider my={4} />
        <NavLink
          component="button"
          onClick={() => setCollapsed(!collapsed)}
          label={collapsed ? undefined : toggleLabel}
          title={toggleLabel}
          aria-label={toggleLabel}
          c="dimmed"
          leftSection={
            collapsed ? (
              <CaretDoubleRight size="1.5rem" style={{ display: "block" }} />
            ) : (
              <CaretDoubleLeft size="1.5rem" style={{ display: "block" }} />
            )
          }
          styles={rowStyles}
        />
      </Box>
      <Box style={{ flexGrow: 1, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Flex>
  );
};

export default ToolboxPage;
