pub mod constants;
pub mod v0;

#[allow(dead_code)]
pub mod v1;

pub fn deserialize_version(data: &[u8], version: u8) -> anyhow::Result<v1::Parser> {
    match version {
        0 => Ok(v0::Parser::from_blob(data)?.into()),
        1 => Ok(v1::Parser::from_encounter_blob(data)?),
        _ => Err(anyhow::anyhow!("Unknown version")),
    }
}

/// [`deserialize_version`] stopped before the expensive part: the raw
/// [`v1::Encounter`] with its event log repopulated, but no derived state.
/// For callers that only read the stored events (the log importer's
/// readability check, coverage report, and identity backfill), replaying the
/// whole event log through the derived-state machinery per blob is pure waste.
pub fn deserialize_encounter(data: &[u8], version: u8) -> anyhow::Result<v1::Encounter> {
    let mut encounter = match version {
        0 => v1::Parser::from(v0::Parser::from_blob(data)?).encounter,
        1 => v1::Encounter::from_blob(data)?,
        _ => return Err(anyhow::anyhow!("Unknown version")),
    };
    encounter.repopulate_event_log();
    Ok(encounter)
}
