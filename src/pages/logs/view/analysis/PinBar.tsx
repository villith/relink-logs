import { ActionIcon, Box, Text } from "@mantine/core";
import { X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

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
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 16px",
        borderBottom: "1px solid var(--an-line)",
        flexWrap: "wrap",
      }}
    >
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
        <Box
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: "var(--an-control-h)",
            padding: "0 6px 0 11px",
            borderRadius: 4,
            border: "1px solid var(--an-accent)",
            backgroundColor: "rgba(0, 184, 217, 0.09)",
          }}
        >
          <Text className="analysis-num" style={{ fontSize: "var(--an-fs-md)", color: "var(--an-accent)" }}>
            {windowLabel}
          </Text>
          {/* `window-of` next door is Classic's full sentence and interpolates
              both ends; this chip already states the window beside it, so it
              needs the shorter "of {{total}}". */}
          <Text style={{ fontSize: "var(--an-fs-xs)", color: "var(--an-ink-3)" }}>
            {t("ui.logs.window-within", { total: fullLabel })}
          </Text>
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
    </Box>
  );
};
