# Changelog

Hand-written notes for each release. The release workflow refuses to tag a
version without a section here, and the section body becomes the GitHub
release body — which the in-app update prompt shows as patch notes. Renders
markdown in the app.

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
