import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

import { FlaggedGear, GearLine, traitLine } from "@/components/FlaggedGear";
import { LegalityFinding } from "@/types";
import {
  formatBonusAmount,
  formatOvermastery,
  formatSummonBonusValue,
  summonBonusValue,
  translateSigilId,
  translateSummonBonusId,
  translateSummonId,
  translateWrightstoneId,
} from "@/utils";
import { violationLabel, violationOf } from "@/violations";

/**
 * The equipment a finding is about, named from the finding itself.
 *
 * Everything drawn here was captured when the rule fired, so this needs no
 * encounter, no fetch and no cache. That is not only cheaper: a finding that
 * carries its own gear cannot be paired with the wrong build, which is what
 * happened when this resolved a slot index against whichever encounter the
 * page had loaded.
 */
export const FindingDetail = ({ finding }: { finding: LegalityFinding }) => {
  const { t } = useTranslation();
  const evidence = finding.evidence;

  // A row stored before the snapshot existed. The sweep refills these, so this
  // is a transient state — but it must never guess a name to fill the gap.
  if (!evidence)
    return (
      <Text size="xs" c="dimmed">
        {t("ui.legality.detail-unavailable")}
      </Text>
    );

  const level = (value: number) => t("ui.trait-level", { level: value });
  const trait = (entry: { id: number; level: number }): GearLine => traitLine(t, entry.id, entry.level);

  /**
   * A summon's equip bonus, with the MAGNITUDE it displays in game.
   *
   * The level alone is not enough: `summonBonusMagnitude` judges the magnitude,
   * so a line reading only "(Lvl. 9)" gave "max +50" nothing to be compared
   * against and the claim read as a riddle. Null when the bonus/level pair is
   * outside the extracted table — then the level is all there is.
   */
  const bonus = (entry: { id: number; level: number }): GearLine => {
    const magnitude = formatSummonBonusValue(entry.id, entry.level);
    // `+ 1` to display: `bonusLevel` is 0-indexed (max 9) and the table is
    // indexed by the raw value, but the game — and the log view's Equipment tab
    // — count from one. Printing the raw index here had the two surfaces
    // disagreeing by one about the same summon.
    const named = `${translateSummonBonusId(entry.id)} ${level(entry.level + 1)}`;
    return { ...entry, text: magnitude === null ? named : `${named} ${magnitude}` };
  };

  /** The ceiling in the same notation the line shows it in, so the two can be
   * read against each other. */
  const allowedBonus = (entry: { id: number; level: number }): string | undefined => {
    if (finding.allowed.kind !== "amount") return undefined;
    const shape = summonBonusValue(entry.id, entry.level);
    return formatBonusAmount({ kind: shape?.kind === "percent" ? "percent" : "flat", amount: finding.allowed.value });
  };

  const item = (name: string, lines: GearLine[], allowed?: string) => (
    <FlaggedGear name={name} lines={lines} findings={[finding]} explain="inline" formatAllowed={() => allowed} />
  );

  switch (evidence.kind) {
    case "sigil":
      return item(`${translateSigilId(evidence.sigilId)} ${level(evidence.level)}`, evidence.traits.map(trait));

    case "wrightstone":
      return item(translateWrightstoneId(evidence.wrightstoneId), evidence.traits.map(trait));

    case "summon":
      return item(
        translateSummonId(evidence.summonId),
        [trait(evidence.main), bonus(evidence.bonus)],
        allowedBonus(evidence.bonus)
      );

    case "summons":
      // The claim is about how many perfect summons there are together, so the
      // set is the subject and each summon is one line of evidence for it.
      return item(
        t("ui.player-summons"),
        evidence.summons.map((summon) => ({
          id: summon.summonId,
          level: 0,
          text: `${translateSummonId(summon.summonId)} — ${bonus(summon.bonus).text}`,
        }))
      );

    case "overmastery":
      return item(formatOvermastery(evidence), []);

    case "overmasteries":
      return item(
        t("ui.player-overmasteries"),
        evidence.entries.map((entry) => ({ id: entry.id, level: 0, text: formatOvermastery(entry) }))
      );

    case "masterTraits":
      // Named through the VIOLATION vocabulary, not a per-rule label: this is
      // the one branch with no gear item to name, and the page already calls
      // this set "Master Traits" on the person's chips. A `ui.legality.rule.*`
      // namespace kept alive for this single call site was one key with no test
      // behind it — the suite that would have caught it renders `limit.*` only.
      return item(violationLabel(t, violationOf(finding.rule)), [
        {
          id: 0,
          level: 0,
          text: t("ui.legality.master-traits-detail", {
            observed: evidence.observed,
            allowed: evidence.allowed,
          }),
        },
      ]);

    default:
      return null;
  }
};
