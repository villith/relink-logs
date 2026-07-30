import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { ArrowCounterClockwise, Camera, ClipboardText, Minus, PushPinSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import { DEFAULT_HEADER_BUTTONS, type HeaderButtonVisibility } from "@/stores/useMeterSettingsStore";

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

  // Defaults underneath the stored value: a settings object persisted before a
  // button existed has no key for it, and `undefined` would silently hide a
  // button the user never chose to hide.
  const shown = { ...DEFAULT_HEADER_BUTTONS, ...visible };

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

      {shown.pin && (
        <Tooltip label={t("ui.pin-window")} color="dark" disabled={!actions}>
          <div className="titlebar-button" onClick={actions?.onPin}>
            <PushPinSimple size={16} />
          </div>
        </Tooltip>
      )}

      {shown.screenshot && (
        <Tooltip label={t("ui.copy-screenshot-to-clipboard")} color="dark" disabled={!actions}>
          <div className="titlebar-button" onClick={actions?.onScreenshot}>
            <Camera size={16} />
          </div>
        </Tooltip>
      )}

      {shown.reset && (
        <Tooltip label={t("ui.reset-session")} color="dark" disabled={!actions}>
          <div className="titlebar-button" onClick={actions?.onReset}>
            <ArrowCounterClockwise size={16} />
          </div>
        </Tooltip>
      )}

      <div className="titlebar-button" id="titlebar-minimize" onClick={actions?.onMinimize}>
        <Minus size={16} />
      </div>
    </>
  );
};
