# Handoff — damage-cap session #5 (Id), 2026-08-10 night

Branch `feat/damage-cap-oracle`, committed through `b81e2025`; working tree
clean (only the pre-existing untracked `src-tauri/examples/supp_pair_probe.rs`).
Offline state: tsc 0; the 11 cap suites (167 tests) green; scripts solver
suites (63) green; `cargo test -p hook` 108 green; hook builds clean.
Supersedes handoff-4 for the Id arc; handoff-4 still holds the Eustace
closure, the g10 result and the tooling notes.

## What this session closed: Id (Pl1900), from the SAME logs

No new captures needed — logs 2571/2573 already carry two Id players (AI
slot 1, remote "Rain" slot 3), and the oracle joins the AI's hits 269/269
and 220/220. Method identical to Eustace's; the probe file is archived next
to the data (see Artifacts below).

The decomposition is EXACT on all 489 joined AI-Id hits, zero exceptions:

    unaccounted = missing channel terms (40 / 35 / 100)
                + 50 (party extra, log 2571 only — same as Eustace's)
                + 25 while transformed / 5 while human

Structure, all proven against the oracle multiset per hit:

1. **Id fights transformed.** ~92% of Id's hits come from the `Pl2000`
   dragon-form body (hook: `ID_DRAGON_TYPE`), not the human `Pl1900` body.
   The short "window" where per-hit snapshots existed (2571: 263–280s,
   2573: 278–313s; Rain likewise) is simply the human-form stretch. Wire
   action ids for dragon-form moves live in a cap-shadow id space: the
   rapid string is 104–109 (`□コンボ4段目・連打1–6(スーパーイド)` in
   `pl1900_action.msg`, whose own table ids are 504–509), 1010 is the
   Godmight Reginleiv cap-shadow (table id 10), skills map
   1000/1100/1200/1400 = 1000 + (tableId−1)×100 for table ids 1,2,3,5.
2. **`6e10311c` coverage banked.** Exactly one unlocked group-35 board node
   fires on 104–109 and 220 (obs-vs-modeled multiset diff; the solver
   itself is double-blocked for pl1900 — every residual confounded by the
   status-gated 40, and two Id players merge the baseline, so
   `solve-2573.txt`'s flags were all it could say). 104–109 → group 0 (the
   □ string family), 220 → group 1 (△ charge-lunge family), per the
   engine's own □/△ naming. **Wire 1010 also carries the group-35 but is
   left unbanked** — no button reading applies to a skill shadow; its 35
   stays visibly unaccounted (n≈3/log) until someone decides its group.
3. **`b81e2025` hook: dragon-form source-state capture.** The per-hit
   HP/status snapshot gate (`SourceState::capture`) bailed on the Pl2000
   body (no own slot key). It now walks the proven `Pl2000 → Pl1900`
   parent link (`dragon_form_owner` in `summon.rs`, same link
   `get_source_parent` uses) and reads the HUMAN body, same slot gate.
   **NOT live-verified yet.**
4. **The +40 node's gate semantics are CORRECT** — `pl1900_0097`, +40
   gated on status 29 = `idodragon` "Dragonform" (status.tbl row 29, hash
   e71c2601). The game applies it exactly while transformed; we could
   never credit it because the snapshot was null (point 3). Post-fix, the
   gate should resolve per hit with zero model changes. (The handoff-4
   worry about wrong gate semantics stands only for trait 1e1cecce.)
5. **+100 windows** = `pl1900_007f`, +100 gated on status 1001 (a real
   status.tbl row, Pl1900-specific — likely the Godmight-peak state inside
   dragon form; 2571 has a ~13s window, 2573 two hits). If status 1001
   sits on the human body's ExStatus, the capture fix credits this too.
6. **Flat +25/+5 runtime extras** (engine keystones family, same bucket as
   Eustace's 115:+15 / 130:+25 / 140:+45): +5 on every Id hit in both
   forms, +20 more while transformed (co-varies exactly with the 40).
   Invisible to both capture streams; still needs keystone valuing or RE
   of the runtime-extras evaluator (unchanged open).

## Live gates for the next game session

1. Rebuild the dev hook with the usual features, tray-reload, play Id (or
   party with AI Id) and confirm: damage events from transformed Id carry
   `source_statuses` (should include 29 while transformed; watch for 1001
   during Godmight peak) and `source_current_hp`.
2. Then a fresh log's debug panel should show the +40 node active on
   transformed hits and Unaccounted ≈ 25 (transformed) / 5 (human) on
   normal actions — only the keystone extras and (2571-style party logs)
   the +50 remain.
3. Eustace hover/debug-panel spot-check from handoff-4 item 1 is still
   pending too.

## Artifacts (previous session's scratchpad — data + probe together)

`C:\Users\Scott\AppData\Local\Temp\claude\C--Users-Scott-Projects-relink-logs\37e19ed0-c4a8-48a2-8e80-ba0d17402e9b\scratchpad\`
— `oracle.txt`, `evidence-{2571,2573,2574,2575}.json`, `id-hits-{2571,2573}.jsonl`
(per-hit obs/mod/status dump), `idOracleProbe.test.ts` (drop back into
`src/pages/logs/view/events/`, run `CAP_ORACLE=1 npx vitest run <file>`;
solo logs 2574/2575 are Eustace-only — no Id data), `tbl/system/table/*`,
and `gamedata/...pl1900_action.msg` in THIS session's scratchpad
(75a76b8f…) for the action-name table.

## Unchanged opens from handoff-4

Buff-magnitude factor family design question (now likely answerable for Id
once snapshots flow); record itemization (display-only); the conditional /
named-mechanics oracle runs for the other 10 characters (solo runs with
nodes unlocked); per-hit capture via the two aggregators; UI surfacing of
evidence classes (ask Scott first).
