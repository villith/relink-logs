import { Group, NumberInput, Slider, Stack, Text } from "@mantine/core";

export type LabelledSliderProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the number, e.g. `px` or `%`. */
  unit: string;
};

/**
 * A slider that says what it is set to.
 *
 * Mantine's own slider label only appears while dragging, so a settings page
 * built from bare sliders cannot answer "what is this at?" without grabbing the
 * handle. The number is an input rather than text so it is also the way to set
 * an exact value, and it gives the slider a real label — a bare `Slider` under
 * a `Text` is unlabelled to a screen reader.
 *
 * Controlled, so the preview beside it moves as the handle does.
 */
export const LabelledSlider = ({ label, value, onChange, min, max, step, unit }: LabelledSliderProps) => (
  <Stack gap={4}>
    <Group justify="space-between" align="center" wrap="nowrap">
      <Text size="sm">{label}</Text>
      <NumberInput
        size="xs"
        w={90}
        min={min}
        max={max}
        step={step}
        value={value}
        suffix={unit}
        clampBehavior="strict"
        aria-label={label}
        onChange={(next) => typeof next === "number" && onChange(next)}
      />
    </Group>
    <Slider
      min={min}
      max={max}
      step={step}
      value={value}
      label={(current) => `${current}${unit}`}
      aria-label={label}
      onChange={onChange}
    />
  </Stack>
);
