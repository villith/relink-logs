import { Box, Group, Text } from "@mantine/core";
import { useMemo } from "react";

import { SkillTargetState } from "@/types";
import { humanizeNumbers, translateEnemyType } from "@/utils";

import { CursorCard } from "./CursorCard";

/** Hover breakdown of a quest-view meter row (player or skill): the row's
 * damage split by enemy, styled as a mini damage meter — one bar per enemy
 * with total-damage and share columns. Follows the cursor, growing up and to
 * the right from it. The breakdown comes from the same filtered reparse as
 * the row's numbers, so it already honors the target and time-window filters.
 * Renders bare children for payloads without breakdown data (live meters pass
 * empty targets).
 *
 * The cursor-following shell — and the rAF throttling and mount-only-while-
 * hovered behaviour that keep a table full of these from janking — is
 * `CursorCard`. */
export const SkillTargetTooltip = ({
  label,
  targets,
  showFullValues,
  color,
  children,
}: {
  /** The hovered row's display name (player or skill), shown in the header. */
  label: string;
  targets: SkillTargetState[];
  showFullValues: boolean;
  /** Bar fill — the hovered row's player color, so the tooltip reads as part of that row. */
  color: string;
  children: React.ReactElement;
}) => {
  const totalDamage = targets.reduce((total, target) => total + target.totalDamage, 0);

  // Built once per data change, not per cursor frame: a reposition re-renders
  // this component every frame, and only the outer box's position should change
  // — the enemy list is referentially stable so React skips re-diffing it.
  const breakdown = useMemo(
    () => (
      <Box miw={260} maw={360}>
        <Text size="xs" fw={600} mb={4}>
          {label}
        </Text>
        {targets.map((target, index) => {
          const percentage = totalDamage > 0 ? (target.totalDamage / totalDamage) * 100 : 0;
          const [damage, damageUnit] = humanizeNumbers(target.totalDamage);

          return (
            <Box key={index} pos="relative" px={8} py={2} mb={2} style={{ overflow: "hidden", borderRadius: 3 }}>
              <Box
                pos="absolute"
                style={{ left: 0, top: 0, bottom: 0, width: `${percentage}%`, backgroundColor: color, opacity: 0.75 }}
              />
              <Group gap={12} wrap="nowrap" pos="relative">
                <Text size="xs" truncate style={{ flex: 1 }}>
                  {translateEnemyType(target.enemyType)}
                </Text>
                <Text size="xs" ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {showFullValues ? target.totalDamage.toLocaleString() : `${damage}${damageUnit}`}
                </Text>
                <Text size="xs" ta="right" w={38} style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {percentage.toFixed(0)}%
                </Text>
              </Group>
            </Box>
          );
        })}
      </Box>
    ),
    [label, targets, totalDamage, showFullValues, color]
  );

  // Nothing to break down — render the row alone rather than an empty tooltip.
  if (targets.length === 0 || totalDamage === 0) {
    return children;
  }

  return (
    <CursorCard
      content={breakdown}
      testId="skill-target-tooltip"
      style={{
        background: "var(--mantine-color-dark-6)",
        color: "var(--mantine-color-white)",
        borderRadius: "var(--mantine-radius-sm)",
        padding: "6px 8px",
        boxShadow: "var(--mantine-shadow-md)",
      }}
    >
      {children}
    </CursorCard>
  );
};
