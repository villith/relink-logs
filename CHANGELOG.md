# Changelog

Hand-written notes for each release. The release workflow refuses to tag a
version without a section here, and the section body becomes the GitHub
release body — which the in-app update prompt shows as patch notes. Renders
markdown in the app.

## 1.12.3

### Features

- The overlay and log window now show whether the parser is properly connected to the game
- Every summon now gets its own named row in the meter instead of collapsing into a single unnamed
entry
- Master level traits in log details are now grouped by Essence/Insight/Crux and are easier to understand at a glance

### Notes

- Primal Burst damage support has been added in this build but is being **excluded** from meters by default. You can turn it on in the settings tab. There is a [poll](https://github.com/villith/relink-logs/discussions/49) available to decide on how Primal Burst should be included in the meters.
- The "Reset Overlay Layout" button was removed from the header. You can find a "Reset Windows" command by right-clicking on the tray icon instead

### Bug Fixes

- Sir Barrold now saves its log entries
- Player stats now appear properly ( except level )
- Stun power now shows properly ( +1 > +10, +1.2 > +12 )
- Synthesis Helper will not suggest a sigil that is equal to the sigil you are trying to craft. [reported by
lingsamuel](https://github.com/villith/relink-logs/issues/33)
- The overlay no longer forces a minimum width

### Language

- The system tray menu is now localized and has a zh-CN translation [credit to Souma-Sumire](https://github.com/Souma-Sumire)
- Further zh-CN skill translations [credit to Souma-Sumire](https://github.com/Souma-Sumire)

## 1.12.2

### Features

- (Linux) Toolbox tools are now available ( parity with Windows client )
  - **Synthesis Helper**: choose the traits you want on a sigil and this tool will give you a list of sigils you own that, when synthesized, will result in the sigil you want
  - **Overmastery Predictor**: select the character, overmastery traits, and the minimum levels you are aiming for, and this tool will give you a list of any upcoming overmastery rolls that match your criteria

### Bug Fixes

- (Linux) Fixed a startup crash caused by newer WebKitGTK versions
- (Linux) Fixed the transparency of the overlay
- (Linux) Fixed the display of the meter rows
- Fixed an issue where if Id's first instance of damage was from his Dragon Form, he would not appear in the log details post-quest ( only applies to logs post-patch )

## 1.12.1

### Bug Fixes

- (Linux) fixed overlay text rendering behind the damage bars
- (Linux) fixed settings changes not reaching the live overlay

### Language

- zh-CN UI Language support has been greatly improved [credit to Souma-Sumire](https://github.com/Souma-Sumire)

## 1.12.0

### Features

- Releases are now code-signed via Microsoft Authenticode: Windows shows a verified publisher when installing, and antivirus false positives should decrease over time
- Perfect Guard stun values now appear in meters
- Perfect Guard (Quickening) against The World will appear as an entry in meters now
- Added a stun column for individual skills
- Added support to select/deselect columns when viewing saved logs
- Stun values that are not Perfect Guard (e.g. Eugen's sticky grenade) now show as their own row instead. If there is no label available they will appear as "Stun Effect". If you know the label, please submit it!

### Bug Fixes

- Online: other players' weapon awakening, wrightstone, and level data no longer shows stale or missing values
- Online: two players playing the same character no longer show each other's equipment
- Damage from system-generated actions (e.g. Conflux buff procs) is attributed correctly in the skill breakdown

### Language

- Beatrix and Fraux skills are now grouped by stance
- Large language updates for all languages. Most skills/sigils/traits/etc. should be labelled now.


## 1.11.1

### Bug Fixes

- Properly track Cagliostro's Pain Train and Alexandria
- Fix parent tracking of Cagliostro, Ferry, and Seofon summons

## 1.11.0

### Features

- Per-enemy damage meters
- Time range scrubber for viewing logs

### Bug Fixes

- DoTs are now properly tracked

### Language

- Added most Endless Ragnarok enemy names in all languages

## 1.10.0

### Features

- New Toolbox tool: Overmastery Predictorsearch your potential overmastery rolls for specific overmasteries
- Automatic updates can now be disabled in settings
- Overlay layout can be reset using the "Reset Overlay Layout" button

### Language

- Numerous non-english language updates for Endless Ragnarok data
