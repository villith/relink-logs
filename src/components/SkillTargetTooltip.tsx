import { Box, Group, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { SkillTargetState } from "@/types";
import { humanizeNumbers, translateEnemyType } from "@/utils";

/** Hover breakdown of a quest-view meter row (player or skill): the row's
 * damage split by enemy, styled as a mini damage meter — one bar per enemy
 * with total-damage and share columns. Follows the cursor, growing up and to
 * the right from it. The breakdown comes from the same filtered reparse as
 * the row's numbers, so it already honors the target and time-window filters.
 * Renders bare children for payloads without breakdown data (live meters pass
 * empty targets). */
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
  const { t } = useTranslation();
  const totalDamage = targets.reduce((total, target) => total + target.totalDamage, 0);

  if (targets.length === 0 || totalDamage === 0) {
    return children;
  }

  return (
    <Tooltip.Floating
      color="dark"
      position="top-start"
      offset={6}
      label={
        <Box miw={260} maw={360}>
          <Text size="xs" fw={600} mb={4}>
            {t("ui.logs.enemy-breakdown", { label })}
          </Text>
          {targets.map((target, index) => {
            const percentage = (target.totalDamage / totalDamage) * 100;
            const [damage, damageUnit] = humanizeNumbers(target.totalDamage);

            return (
              <Box key={index} pos="relative" px={8} py={2} mb={2} style={{ overflow: "hidden", borderRadius: 3 }}>
                <Box
                  pos="absolute"
                  style={{
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${percentage}%`,
                    backgroundColor: color,
                    opacity: 0.75,
                  }}
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
      }
    >
      {children}
    </Tooltip.Floating>
  );
};
