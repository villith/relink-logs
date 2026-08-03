//! The magnitude a summon equip bonus DISPLAYS, and which effect it grants.
//!
//! Two id sets grant the same eleven effects: a standard set most summons draw
//! from, and a higher-magnitude set granted only by Rolan, Lucilius, Beelzebub
//! and Lilith (Healing Cap Up tops out at +50% in the first and +75% in the
//! second). Judging whether a magnitude is reachable therefore has to compare
//! ACROSS the id boundary — a Behemoth III showing +75% is only provably
//! impossible once its own Healing Cap Up id is known to stop at +50%. That
//! comparison is what [`Bonus::effect`] exists for.
//!
//! The effect key is the bonus's ENGLISH display name, the same join
//! `summons::allowed_mains` already uses for summon names, and it carries the
//! same game-update fragility — so it gets the same style of drift guard in
//! the tests below.

use std::collections::HashMap;

use serde::Deserialize;

use super::parse_hex;

/// One row of `summon-bonus-values.json`, as generated.
#[derive(Debug, Clone, Deserialize)]
struct RawValues {
    /// Displayed magnitude per level, indexed by the raw bonus level.
    values: Vec<f64>,
    /// A percentage rather than a flat amount.
    percent: bool,
}

/// One equip bonus: what it displays, and the effect it grants.
#[derive(Debug, Clone)]
pub struct Bonus {
    /// Displayed magnitude per level, indexed by the raw bonus level.
    pub values: Vec<f64>,
    /// A percentage rather than a flat amount. Read only by the drift guard,
    /// which uses it to prove the two ids of one effect are comparable at all.
    pub percent: bool,
    /// English display name — the key that joins the standard and boss
    /// spellings of one effect so their magnitudes can be compared.
    pub effect: String,
}

/// One row of `lang/en/summon-bonuses.json`, read only for its display name.
#[derive(Debug, Clone, Deserialize)]
struct RawName {
    text: String,
}

/// The baked bonus table, keyed by bonus id. A row whose id will not parse is
/// dropped: an unreadable row is missing data, never a judgement.
pub fn bonus_table() -> &'static HashMap<u32, Bonus> {
    static TABLE: std::sync::OnceLock<HashMap<u32, Bonus>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let values: HashMap<String, RawValues> =
            serde_json::from_str(include_str!("../../assets/summon-bonus-values.json"))
                .expect("summon-bonus-values.json matches the generated shape");
        let names: HashMap<String, RawName> =
            serde_json::from_str(include_str!("../../lang/en/summon-bonuses.json"))
                .expect("summon-bonuses.json matches the lang shape");

        values
            .into_iter()
            .filter_map(|(key, raw)| {
                let id = parse_hex(&key)?;
                // An id the lang file does not name groups under its own hex
                // spelling, so it can only ever match itself — it never
                // silently shares a ceiling with an unrelated effect.
                let effect = names.get(&key).map_or(key, |name| name.text.clone());
                Some((
                    id,
                    Bonus {
                        values: raw.values,
                        percent: raw.percent,
                        effect,
                    },
                ))
            })
            .collect()
    })
}

/// The magnitude `id` displays at `level`, or `None` when it displays nothing:
/// an unknown id, or a level off the end of the table.
///
/// That second case is load-bearing. Every above-window level in a 692-log
/// census is the `4294967295` unread sentinel, and it indexes past the end of
/// every value list — so an unread bonus prices nothing and the magnitude rule
/// stays silent on it without needing to know what a sentinel is.
pub fn magnitude(id: u32, level: u32) -> Option<f64> {
    let bonus = bonus_table().get(&id)?;
    bonus.values.get(usize::try_from(level).ok()?).copied()
}

/// The effect `id` grants — the key that lets a boss-set magnitude be compared
/// against a standard-set ceiling.
pub fn effect_of(id: u32) -> Option<&'static str> {
    bonus_table().get(&id).map(|bonus| bonus.effect.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two Healing Cap Up ids: the standard set stops at +50%, the boss set
    /// reaches +75%.
    const STANDARD_HEALING_CAP: u32 = 0x2270_bc40;
    const BOSS_HEALING_CAP: u32 = 0x2ea9_ca80;

    #[test]
    fn magnitude_reads_the_table_and_is_silent_off_the_end() {
        assert_eq!(magnitude(STANDARD_HEALING_CAP, 9), Some(50.0));
        assert_eq!(magnitude(BOSS_HEALING_CAP, 9), Some(75.0));

        // The unread sentinel and any other out-of-range index price nothing.
        assert_eq!(magnitude(BOSS_HEALING_CAP, u32::MAX), None);
        assert_eq!(magnitude(BOSS_HEALING_CAP, 10), None);
        assert_eq!(magnitude(0xdead_beef, 0), None);
    }

    /// The two spellings of one effect must group together, or the magnitude
    /// rule has nothing to compare a +75% Healing Cap Up against.
    #[test]
    fn the_two_ids_of_one_effect_share_an_effect_key() {
        let standard = effect_of(STANDARD_HEALING_CAP).expect("standard healing cap is a bonus");
        let boss = effect_of(BOSS_HEALING_CAP).expect("boss healing cap is a bonus");
        assert_eq!(standard, boss);
    }

    /// THE LANG-DRIFT GUARD. `effect` joins on the ENGLISH display name out of
    /// an autogenerated lang file that a game update overwrites (see
    /// CLAUDE.md). If a regeneration re-spells one id of a pair, the two stop
    /// sharing an effect and the magnitude rule silently loses its ceiling —
    /// it would go QUIET rather than fail, which is the worst failure mode
    /// available to a rule nobody is watching.
    #[test]
    fn every_effect_owns_exactly_two_ids_of_one_unit() {
        let mut by_effect: std::collections::BTreeMap<&str, Vec<u32>> = Default::default();
        for (&id, bonus) in bonus_table() {
            by_effect.entry(bonus.effect.as_str()).or_default().push(id);
        }

        assert_eq!(
            bonus_table().len(),
            22,
            "expected 22 summon equip-bonus ids"
        );
        assert_eq!(by_effect.len(), 11, "expected 11 distinct effects");

        for (effect, ids) in &by_effect {
            assert_eq!(
                ids.len(),
                2,
                "effect {effect} should own exactly two ids (a standard and a boss spelling)"
            );
            let units: Vec<bool> = ids.iter().map(|id| bonus_table()[id].percent).collect();
            assert_eq!(
                units[0], units[1],
                "effect {effect} mixes percent and flat ids, so their magnitudes are not comparable"
            );
        }
    }

    /// The boss set must actually out-reach the standard set for every effect.
    /// If a regeneration flattened them, the magnitude rule could never fire
    /// and the test above would still pass.
    #[test]
    fn one_id_of_each_effect_reaches_higher_than_the_other() {
        let mut by_effect: std::collections::BTreeMap<&str, Vec<f64>> = Default::default();
        for bonus in bonus_table().values() {
            let top = bonus.values.iter().copied().fold(f64::MIN, f64::max);
            by_effect
                .entry(bonus.effect.as_str())
                .or_default()
                .push(top);
        }

        for (effect, tops) in &by_effect {
            assert_ne!(
                tops[0], tops[1],
                "effect {effect}'s two ids reach the same magnitude, so no ceiling separates them"
            );
        }
    }
}
