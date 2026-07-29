import NewChip, { NEW_CHIP_COLOR } from "@/components/NewChip";
import { isNew, NewFeatureId } from "@/newFeatures";
import { Box, Divider, Indicator, NavLink } from "@mantine/core";
import { CaretDoubleLeft, CaretDoubleRight } from "@phosphor-icons/react";
// `Icon` is a type-only export — a value import survives today only because
// esbuild elides it, and would break under verbatimModuleSyntax.
import type { Icon } from "@phosphor-icons/react";
import { Link, useLocation } from "react-router-dom";

/** One row of the rail. `label` arrives already translated; `newId` (optional)
 * keys into NEW_FEATURES and lights the row's "New" marker. */
export type NavRailItem = {
  to: string;
  label: string;
  icon: Icon;
  newId?: NewFeatureId;
};

/**
 * The left-hand section menu shared by the Toolbox and Settings pages: one
 * NavLink per section over a collapse toggle. Collapsed it shows icons only,
 * and a "New" chip degrades to a chip-colored dot on the icon (there is no
 * room for the badge). The caller owns the collapsed flag — each page persists
 * its own — and supplies the toggle's labels so neither page has to borrow the
 * other's translation keys.
 */
export const CollapsibleNavRail = ({
  items,
  collapsed,
  onToggle,
  expandLabel,
  collapseLabel,
}: {
  items: NavRailItem[];
  collapsed: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) => {
  const { pathname } = useLocation();

  // Hard-fixed row height: the label's line box (~40.8px row) vs icon-only
  // (40px row) would otherwise shift everything a fraction on collapse.
  const rowStyles = {
    root: { height: 42 },
    body: collapsed ? { display: "none" as const } : undefined,
  };
  const toggleLabel = collapsed ? expandLabel : collapseLabel;

  return (
    <Box w={collapsed ? 56 : 300} style={{ flexShrink: 0 }}>
      {items.map(({ to, label, icon: ItemIcon, newId }) => (
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
      ))}
      <Divider my={4} />
      <NavLink
        component="button"
        onClick={onToggle}
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
  );
};

export default CollapsibleNavRail;
