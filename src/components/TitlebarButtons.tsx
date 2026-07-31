import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { ArrowCounterClockwise, Camera, ClipboardText, Icon, Minus, PushPinSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import {
  headerButtonsWithDefaults,
  type HeaderButtonId,
  type HeaderButtonVisibility,
} from "@/stores/useMeterSettingsStore";

/** The glyph each toggleable header button wears. Exported so the settings
 * checkbox for a button can show the button — a name alone ("Pin on top") does
 * not tell you which of the icons in the header it is going to remove. */
export const HEADER_BUTTON_ICONS: Record<HeaderButtonId, Icon> = {
  clipboard: ClipboardText,
  pin: PushPinSimple,
  screenshot: Camera,
  reset: ArrowCounterClockwise,
};

/**
 * The three buttons that are a tooltip over a glyph, differing only in which
 * action they fire. Written out once so adding a fourth is one row here rather
 * than a fourth copy of the same seven lines.
 *
 * Clipboard is not in the table: it is a hover menu with two items, not a
 * single-action button, so it keeps its own branch below.
 */
const TOOLTIP_BUTTONS: ReadonlyArray<{
  id: HeaderButtonId;
  labelKey: string;
  handler: (actions: TitlebarActions) => () => void;
}> = [
  { id: "pin", labelKey: "ui.pin-window", handler: (a) => a.onPin },
  { id: "screenshot", labelKey: "ui.copy-screenshot-to-clipboard", handler: (a) => a.onScreenshot },
  { id: "reset", labelKey: "ui.reset-session", handler: (a) => a.onReset },
];

export type TitlebarActions = {
  onCopySimple: () => void;
  onCopyFull: () => void;
  onPin: () => void;
  onScreenshot: () => void;
  onReset: () => void;
  onMinimize: () => void;
};

export type TitlebarButtonsProps = {
  /** Which buttons the user has kept. */
  visible: HeaderButtonVisibility;
  /** Omitted in the settings preview, which draws the same buttons but wires
   * nothing to them — every handler here talks to a real window or the game. */
  actions?: TitlebarActions;
};

/**
 * The overlay header's action buttons.
 *
 * Shared by the real titlebar and the settings preview for the same reason
 * HeaderSegments is: a preview that draws its own approximation of the header
 * drifts from the header. These buttons take up real estate beside the
 * segments, so a preview without them mis-states how much room the text has.
 *
 * Minimize is always drawn and has no toggle — see HEADER_BUTTONS.
 */
export const TitlebarButtons = ({ visible, actions }: TitlebarButtonsProps) => {
  const { t } = useTranslation();

  const shown = headerButtonsWithDefaults(visible);

  return (
    <>
      {shown.clipboard &&
        (actions ? (
          <Menu shadow="md" trigger="hover" openDelay={100} closeDelay={400}>
            <Menu.Target>
              <ActionIcon aria-label={t("ui.copy-to-clipboard")} variant="transparent" color="light">
                <ClipboardText size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={actions.onCopySimple}>{t("ui.copy-to-clipboard-simple")}</Menu.Item>
              <Menu.Item onClick={actions.onCopyFull}>{t("ui.copy-to-clipboard-full")}</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : (
          // A hover menu in an inert preview would never open, so the preview
          // shows the trigger alone rather than pretending to be interactive.
          <ActionIcon aria-label={t("ui.copy-to-clipboard")} variant="transparent" color="light">
            <ClipboardText size={16} />
          </ActionIcon>
        ))}

      {TOOLTIP_BUTTONS.map(({ id, labelKey, handler }) => {
        const Glyph = HEADER_BUTTON_ICONS[id];
        return (
          shown[id] && (
            <Tooltip key={id} label={t(labelKey)} color="dark" disabled={!actions}>
              <div className="titlebar-button" onClick={actions && handler(actions)}>
                <Glyph size={16} />
              </div>
            </Tooltip>
          )
        );
      })}

      <div className="titlebar-button" id="titlebar-minimize" onClick={actions?.onMinimize}>
        <Minus size={16} />
      </div>
    </>
  );
};
