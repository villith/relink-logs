import CollapsibleNavRail from "@/components/CollapsibleNavRail";
import { Box, Flex } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { Gauge, ListChecks, SlidersHorizontal } from "@phosphor-icons/react";
// `Icon` is a type-only export — a value import survives today only because
// esbuild elides it, and would break under verbatimModuleSyntax.
import type { Icon } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router-dom";

/** The sections in the settings side menu, in display order. */
export const SETTINGS_SECTIONS: {
  to: string;
  labelKey: string;
  labelFallback: string;
  icon: Icon;
}[] = [
  {
    to: "/logs/settings/general",
    labelKey: "ui.settings-nav.general",
    labelFallback: "General",
    icon: SlidersHorizontal,
  },
  {
    to: "/logs/settings/meters",
    labelKey: "ui.settings-nav.meters",
    labelFallback: "Meters",
    icon: Gauge,
  },
  {
    to: "/logs/settings/checklist",
    labelKey: "ui.checklist-settings.title",
    labelFallback: "Checklist",
    icon: ListChecks,
  },
];

/** Settings: collapsible section menu on the left, the selected section on the
 * right — the same shell the Toolbox uses. Its collapsed state is stored under
 * its own key so the two menus stay independent. */
const SettingsPage = () => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useLocalStorage({ key: "settings-menu-collapsed", defaultValue: false });
  const items = SETTINGS_SECTIONS.map(({ to, labelKey, labelFallback, icon }) => ({
    to,
    label: t(labelKey, labelFallback),
    icon,
  }));

  return (
    <Flex gap="md" align="flex-start">
      <CollapsibleNavRail
        items={items}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        expandLabel={t("ui.settings-nav.expand-menu", "Expand menu")}
        collapseLabel={t("ui.settings-nav.collapse-menu", "Collapse menu")}
      />
      <Box style={{ flexGrow: 1, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Flex>
  );
};

export default SettingsPage;
