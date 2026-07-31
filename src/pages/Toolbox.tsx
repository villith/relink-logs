import NavRailLayout, { type NavRailSection } from "@/components/NavRailLayout";
import { useIsLinux } from "@/platform";
import { Flask, MagicWand, ShieldWarning, Sparkle } from "@phosphor-icons/react";

/** The tools in the side menu. `newId` (optional) keys into NEW_FEATURES. */
export const TOOLS: (NavRailSection & { windowsOnly?: boolean })[] = [
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
  {
    to: "/logs/toolbox/audit",
    labelKey: "ui.toolbox.cheat-audit",
    labelFallback: "Cheat Audit",
    icon: ShieldWarning,
    newId: "cheat-audit",
  },
];

/** Tools visible on this platform. All current tools are served by the hook
 * over the toolbox RPC channel and work everywhere; the mechanism stays for
 * any future platform-gated tool. */
export const visibleTools = <T extends { windowsOnly?: boolean }>(tools: T[], isLinux: boolean): T[] =>
  tools.filter((tool) => !(isLinux && tool.windowsOnly));

/** Toolbox: collapsible tool menu on the left, the selected tool on the right. */
const ToolboxPage = () => {
  const isLinux = useIsLinux();

  return <NavRailLayout sections={visibleTools(TOOLS, isLinux)} storageKey="toolbox-menu-collapsed" />;
};

export default ToolboxPage;
