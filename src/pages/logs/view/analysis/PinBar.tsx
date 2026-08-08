import { ActionIcon, Box, Text } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { Figure } from "@/components/ui/Figure";
import { Strip } from "@/components/ui/Strip";

import type { SelectorPins } from "../selectorOptions";

import { PinSelect, type LabelledOption } from "./PinSelect";

import "./analysis.css";

export type { LabelledOption };

export type PinBarProps = {
  options: { targets: LabelledOption[]; abilities: LabelledOption[] };
  pins: SelectorPins;
  onChange: (pins: SelectorPins) => void;
  /** Formatted window, or null for the full fight. */
  windowLabel: string | null;
  /** The whole fight's duration, so a scoped window stays located in it. */
  fullLabel: string;
  onClearWindow: () => void;
};

/** The target and ability pins, and the window readout.
 *
 * The ACTOR pin is not here — it sits in the topmost row with the view switch
 * (see ActorBar), because it is the one pin that outranks the side and the
 * metric. These two narrow whatever the metric below is showing, so they stay
 * with it.
 *
 * No label in front of each selector: the placeholder already names the
 * dimension — "All enemies" cannot be mistaken for an ability — so a label
 * repeats it. Left-to-right order carries the rest.
 *
 * The window is deliberately not a selector. It is set by dragging the chart
 * and only cleared here. */
export const PinBar = ({ options, pins, onChange, windowLabel, fullLabel, onClearWindow }: PinBarProps) => {
  const { t } = useTranslation();

  return (
    <Strip wrap className="py-2.5">
      {/* Single like the machine's target axis (WCL's): one spawn or All —
          `targets` still travels as a list only because the legacy pin shape
          does. */}
      <PinSelect
        minWidth={240}
        data={options.targets}
        value={pins.targets.length === 0 ? null : String(pins.targets[0])}
        placeholder={t("ui.logs.selector-all-enemies")}
        ariaLabel={t("ui.logs.selector-target")}
        onChange={(value) => onChange({ ...pins, targets: value === null ? [] : [Number(value)] })}
      />
      {/* The widest basis of the three: an ability is named through its cause
          ("Guardpoint (Sigil)"), which makes it the longest thing any of these
          rows has to hold. */}
      <PinSelect
        minWidth={300}
        data={options.abilities}
        value={pins.ability}
        placeholder={t("ui.logs.selector-all-abilities")}
        ariaLabel={t("ui.logs.selector-ability")}
        onChange={(value) => onChange({ ...pins, ability: value })}
      />
      {windowLabel !== null && (
        <Box className="ml-auto inline-flex h-control items-center gap-1.5 rounded-sm border border-accent bg-accent-soft pl-[11px] pr-1.5">
          <Figure size="md" className="text-accent">
            {windowLabel}
          </Figure>
          {/* `window-of` next door is Classic's full sentence and interpolates
              both ends; this chip already states the window beside it, so it
              needs the shorter "of {{total}}". */}
          <Text className="text-xs text-ink-3">{t("ui.logs.window-within", { total: fullLabel })}</Text>
          {/* sm, not xs: this is the only control that clears a window, and xs
              measured 18x18 against WCAG 2.2 SC 2.5.8's 24x24. */}
          <ActionIcon
            size="sm"
            variant="transparent"
            color="gray"
            aria-label={t("ui.logs.window-reset")}
            title={t("ui.logs.window-reset")}
            onClick={onClearWindow}
          >
            <X size={12} weight="bold" />
          </ActionIcon>
        </Box>
      )}
    </Strip>
  );
};
