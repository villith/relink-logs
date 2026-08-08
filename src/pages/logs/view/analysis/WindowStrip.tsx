import { ActionIcon, Box, Menu, UnstyledButton } from "@mantine/core";
import { CaretDown, Check, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { Figure } from "@/components/ui/Figure";
import { Label } from "@/components/ui/Label";
import { Strip } from "@/components/ui/Strip";

import { WINDOW_BAND_COLOR } from "./chartWindowBands";
import {
  CHIP_BUTTON_CLASS,
  CHIP_BUTTON_SELECTED_CLASS,
  CHIP_CLASS,
  CHIP_SELECTED_CLASS,
  CHIP_SWATCH_CLASS,
} from "./chipAnatomy";
import { DROPDOWN_PANEL_CLASS, MENU_ITEM_CLASS } from "./dropdownSkin";
import type { WindowChipGroup } from "./windowChips";

export type WindowStripProps = {
  groups: WindowChipGroup[];
  /** Toggles ONE individual window (`sba:1`). */
  onToggleWindow: (win: string) => void;
  /** Toggles a whole kind (`sba`) — the menu's first row. */
  onToggleKind: (kind: string) => void;
  onClear: () => void;
};

/** The tick in front of a menu row. Always drawn, empty when unticked: a glyph
 * that appears and disappears moves the label under the cursor, and a menu the
 * eye is scanning down a column of is the worst place for that. */
const MenuTick = ({ checked }: { checked: boolean }) => (
  <Box
    aria-hidden
    className={[
      "inline-flex size-[calc(13px*var(--density))] flex-none items-center justify-center rounded-xs border",
      checked ? "border-accent bg-accent text-bg" : "border-line-strong",
    ].join(" ")}
  >
    {checked && <Check size={9} weight="bold" />}
  </Box>
);

/** One row of battle-window chips — the window filter's whole UI.
 *
 * One chip PER KIND, each opening a menu of that kind's windows. The chips used
 * to be flat — a kind chip followed by every window under it — which on a long
 * fight wrapped three or four rows deep between the chart and the table for a
 * control that is read once and then mostly left alone.
 *
 * The whole chip opens the menu; "All <kind> windows" is the first row inside
 * rather than a second meaning for clicking the chip itself. Selection is
 * multiple and crosses kinds — SBA #1 with Break #3 is a legitimate reading —
 * so the menu stays open across clicks, and the strip carries one ✕ for all of
 * it rather than one per chip.
 *
 * Renders nothing with no groups: a strip exists only while what anchors it
 * does, and an empty row of chrome would say nothing. */
export const WindowStrip = ({ groups, onToggleWindow, onToggleKind, onClear }: WindowStripProps) => {
  const { t } = useTranslation();

  if (groups.length === 0) return null;

  const anySelected = groups.some((group) => group.active);

  return (
    <Strip rule="top" wrap>
      <Label>{t("ui.logs.window-strip-title")}</Label>
      {groups.map((group) => (
        // `closeOnItemClick={false}`: every row here is a checkbox, and a menu
        // that shut on the first tick would make picking three windows three
        // trips through the chip.
        <Menu
          key={group.kind}
          closeOnItemClick={false}
          position="bottom-start"
          withinPortal
          // The view's own surface rather than Mantine's stock popover — the
          // same one the pin selectors drop (see `dropdownSkin`). Without it
          // this menu opens out of a token-built chip into a panel with a
          // different background, border, radius and row height.
          classNames={{
            dropdown: DROPDOWN_PANEL_CLASS,
            item: MENU_ITEM_CLASS,
            // Mantine reserves a wide gutter for these; around a 13px tick and
            // a duration figure that reads as a gap rather than as part of the
            // row. The gap between item content is the item's own.
            itemSection: "text-ink-3",
          }}
        >
          <Menu.Target>
            <Box className={[CHIP_CLASS, group.active ? CHIP_SELECTED_CLASS : ""].join(" ")}>
              <UnstyledButton
                className={[CHIP_BUTTON_CLASS, group.active ? CHIP_BUTTON_SELECTED_CLASS : ""].join(" ")}
                aria-haspopup="menu"
                aria-label={t("ui.logs.window-chip-menu-label", { label: group.kindLabel })}
              >
                <span
                  className={CHIP_SWATCH_CLASS}
                  style={{ backgroundColor: WINDOW_BAND_COLOR[group.kind] }}
                  aria-hidden
                />
                <span>{group.kindLabel}</span>
                <Figure data-chip-figure size="xs" tone="dim">
                  {group.figure}
                </Figure>
                <CaretDown size={10} weight="bold" aria-hidden />
              </UnstyledButton>
            </Box>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              data-window-all
              leftSection={<MenuTick checked={group.allSelected} />}
              onClick={() => onToggleKind(group.allValue)}
            >
              {t("ui.logs.window-menu-all", { label: group.kindLabel })}
            </Menu.Item>
            {group.items.map((item) => (
              <Menu.Item
                key={item.value}
                data-window-item={item.value}
                // A kind row admits every window under it, so the individual
                // rows read as ticked while it is — and toggling one of them
                // then would have to un-tick the kind to mean anything, which
                // is a menu that rewrites its own first row under the cursor.
                disabled={group.allSelected}
                leftSection={<MenuTick checked={group.allSelected || item.selected} />}
                rightSection={
                  <Figure size="xs" tone="dim">
                    {item.durationLabel}
                  </Figure>
                }
                onClick={() => onToggleWindow(item.value)}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ))}
      {/* ONE clear for the whole strip. Per-chip ✕s would each mean "clear this
          kind", which is what unticking its rows already says, and four of them
          in a row reads as four different filters. */}
      {anySelected && (
        <ActionIcon
          size="sm"
          variant="transparent"
          color="gray"
          aria-label={t("ui.logs.window-clear")}
          title={t("ui.logs.window-clear")}
          onClick={onClear}
        >
          <X size={12} weight="bold" />
        </ActionIcon>
      )}
    </Strip>
  );
};
