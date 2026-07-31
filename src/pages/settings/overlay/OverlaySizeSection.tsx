import useSettings from "@/pages/useSettings";
import { DEFAULT_OVERLAY_SIZE, OVERLAY_MIN_SIZE } from "@/stores/useMeterSettingsStore";
import { Anchor, Group, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Ceiling on either dimension. Larger than any monitor the overlay would sit
 * on, so it only ever catches a typo. */
const OVERLAY_MAX_SIZE = 4000;

type PixelInputProps = {
  label: string;
  value: number;
  min: number;
  onCommit: (value: number) => void;
};

/**
 * A pixel measurement, typed freely and applied when the user is done.
 *
 * Deliberately not a NumberInput: that one reformats and re-clamps on every
 * keystroke, so with a floor of 250 the "3" of "300" is instantly rewritten to
 * "250" and the caret jumps — you could only ever type at the very start of the
 * field. Holding a draft string and clamping once, on blur or Enter, lets the
 * value pass through states that are not yet valid, which is what typing is.
 */
const PixelInput = ({ label, value, min, onCommit }: PixelInputProps) => {
  const [draft, setDraft] = useState(String(value));

  // Follows the stored value when something else changes it — a reset here, or
  // the user dragging the overlay's own edge. Typing does not trip this: the
  // draft is local until it is committed.
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isNaN(parsed)) {
      setDraft(String(value)); // an emptied field means "never mind", not "0"
      return;
    }
    const clamped = Math.min(OVERLAY_MAX_SIZE, Math.max(min, parsed));
    setDraft(String(clamped));
    onCommit(clamped);
  };

  return (
    <TextInput
      label={label}
      value={draft}
      inputMode="numeric"
      onChange={(event) => setDraft(event.currentTarget.value.replace(/[^0-9]/g, ""))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
};

/**
 * The overlay window's size, in logical pixels.
 *
 * Two-way: typing here resizes the overlay, and dragging the overlay's edge
 * writes the new size back into these fields (see useOverlaySize). Worth having
 * as numbers rather than only a drag handle because the narrow-header rule is a
 * width threshold — you cannot aim at it by dragging.
 */
export const OverlaySizeSection = () => {
  const { t } = useTranslation();
  const { overlay_width, overlay_height, setMeterSettings } = useSettings();

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="md" fw={700}>
          {t("ui.overlay-size-section")}
        </Text>
        <Anchor
          component="button"
          type="button"
          size="xs"
          onClick={() => setMeterSettings({ ...DEFAULT_OVERLAY_SIZE })}
        >
          {t("ui.reset-to-defaults")}
        </Anchor>
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <PixelInput
          label={t("ui.overlay-width")}
          value={overlay_width}
          min={OVERLAY_MIN_SIZE.width}
          onCommit={(overlay_width) => setMeterSettings({ overlay_width })}
        />
        <PixelInput
          label={t("ui.overlay-height")}
          value={overlay_height}
          min={OVERLAY_MIN_SIZE.height}
          onCommit={(overlay_height) => setMeterSettings({ overlay_height })}
        />
      </SimpleGrid>
    </Stack>
  );
};
