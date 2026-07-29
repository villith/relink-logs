import NavRailLayout, { type NavRailSection } from "@/components/NavRailLayout";
import { Gauge, ListChecks, SlidersHorizontal } from "@phosphor-icons/react";

/** The sections in the settings side menu, in display order. */
const SETTINGS_SECTIONS: NavRailSection[] = [
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
const SettingsPage = () => <NavRailLayout sections={SETTINGS_SECTIONS} storageKey="settings-menu-collapsed" />;

export default SettingsPage;
