import NewChip, { NEW_CHIP_COLOR } from "@/components/NewChip";
import { isNew, NewFeatureId } from "@/newFeatures";
import { Box, Divider, Flex, Indicator, NavLink } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { CaretDoubleLeft, CaretDoubleRight } from "@phosphor-icons/react";
// `Icon` is a type-only export — a value import survives today only because
// esbuild elides it, and would break under verbatimModuleSyntax.
import type { Icon } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router-dom";

/** One section of the rail. `newId` (optional) keys into NEW_FEATURES and
 * lights the row's "New" marker. */
export type NavRailSection = {
  to: string;
  labelKey: string;
  labelFallback: string;
  icon: Icon;
  newId?: NewFeatureId;
};

/**
 * The page shell shared by the Toolbox and Settings pages: a collapsible
 * section menu on the left, the selected section's route on the right. One
 * NavLink per section over a collapse toggle; collapsed it shows icons only,
 * and a "New" chip degrades to a chip-colored dot on the icon (there is no
 * room for the badge).
 *
 * The collapsed flag is persisted under the caller's `storageKey`, so each
 * page's menu stays independent while the shell itself stays in one place.
 * Sections arrive untranslated — the rail owns the lookup, so a new rail needs
 * no translation keys of its own beyond its section labels.
 */
export const NavRailLayout = ({ sections, storageKey }: { sections: NavRailSection[]; storageKey: string }) => {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useLocalStorage({ key: storageKey, defaultValue: false });

  // Hard-fixed row height: the label's line box (~40.8px row) vs icon-only
  // (40px row) would otherwise shift everything a fraction on collapse.
  const rowStyles = {
    root: { height: 42 },
    body: collapsed ? { display: "none" as const } : undefined,
  };
  const toggleLabel = collapsed
    ? t("ui.nav-rail.expand-menu", "Expand menu")
    : t("ui.nav-rail.collapse-menu", "Collapse menu");

  return (
    <Flex gap="md" align="flex-start">
      <Box w={collapsed ? 56 : 300} style={{ flexShrink: 0 }}>
        {sections.map(({ to, labelKey, labelFallback, icon: ItemIcon, newId }) => {
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
                  <ItemIcon size="1.5rem" style={{ display: "block" }} />
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

export default NavRailLayout;
