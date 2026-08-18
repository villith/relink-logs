import { Box, Menu, UnstyledButton } from "@mantine/core";
import { CaretDown } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { Label } from "@/components/ui/Label";

import { MenuTick } from "./MenuTick";
import { CHIP_BUTTON_CLASS, CHIP_CLASS } from "./chipAnatomy";
import { DROPDOWN_PANEL_CLASS, MENU_ITEM_CLASS } from "./dropdownSkin";

/** Selectable trailing-average windows, in buckets. One bucket is one second
 * (`DPS_BUCKET_MS`), so a value IS its duration in seconds; 1 is "off", since a
 * one-bucket trailing mean is the bucket itself. */
export const SMOOTHING_OPTIONS = [1, 5, 10, 30];

export type SmoothingSelectProps = {
  /** The trailing window in BUCKETS. */
  value: number;
  onChange: (buckets: number) => void;
};

/** The chart's trailing-average window, as a dropdown.
 *
 * A `PillGroup` before this, which spent four pills of the control row on a
 * choice that is made once and then left — beside the band and marker switches,
 * which are the row's actual traffic. A dropdown states the current window and
 * costs one slot.
 *
 * The caption is the menu's own first line rather than a word in front of the
 * trigger. "Off 5s 10s 30s" names four durations and no question, so something
 * has to say what is being chosen — but a permanent "Smoothing" beside a control
 * whose closed state already reads "10s" says it to everyone forever. Inside, it
 * is there exactly when the choice is being made. The trigger still carries the
 * question for screen readers (`aria-label`) and, with the explanation, on
 * hover. */
export const SmoothingSelect = ({ value, onChange }: SmoothingSelectProps) => {
  const { t } = useTranslation();

  const optionLabel = (buckets: number) =>
    buckets === 1 ? t("ui.logs.chart-smoothing-off") : t("ui.logs.chart-smoothing-seconds", { seconds: buckets });

  return (
    <Menu
      position="bottom-end"
      withinPortal
      // The view's own surface, like every other dropdown here — see
      // `dropdownSkin`.
      classNames={{ dropdown: DROPDOWN_PANEL_CLASS, item: MENU_ITEM_CLASS, itemSection: "text-ink-3" }}
    >
      <Menu.Target>
        <Box className={CHIP_CLASS}>
          <UnstyledButton
            data-smoothing-trigger
            className={CHIP_BUTTON_CLASS}
            aria-haspopup="menu"
            aria-label={t("ui.logs.chart-smoothing-label")}
            title={t("ui.logs.chart-smoothing-hint")}
          >
            <span>{optionLabel(value)}</span>
            <CaretDown size={10} weight="bold" aria-hidden />
          </UnstyledButton>
        </Box>
      </Menu.Target>
      <Menu.Dropdown>
        {/* Mantine's own label padding would set this off from the rows below
            it by more than the panel is wide at; the row padding is the panel's
            own (`MENU_ITEM_CLASS`). */}
        <Menu.Label className="px-2 pb-0.5 pt-1">
          <Label>{t("ui.logs.chart-smoothing-caption")}</Label>
        </Menu.Label>
        {SMOOTHING_OPTIONS.map((buckets) => (
          <Menu.Item
            key={buckets}
            data-smoothing-option={buckets}
            leftSection={<MenuTick checked={buckets === value} />}
            onClick={() => onChange(buckets)}
          >
            {optionLabel(buckets)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
};
