# relink-logs

[![GitHub Release](https://img.shields.io/github/v/release/villith/relink-logs)](https://github.com/villith/relink-logs/releases)
[![GitHub Downloads](https://img.shields.io/github/downloads/villith/relink-logs/total)](https://github.com/villith/relink-logs/releases)
[![GitHub License](https://img.shields.io/github/license/villith/relink-logs)](./LICENSE)

Overlay DPS parser/meter for Granblue Fantasy: Relink.

Relink Logs was built upon [false-spring/gbfr-logs](https://github.com/false-spring/gbfr-logs), which is no longer maintained. This project is an independent continuation and is **not affiliated with** the original gbfr-logs project. The original work was based on the reverse engineering from [nyaoouo/GBFR-ACT](https://github.com/nyaoouo/GBFR-ACT).

## What's new in Relink Logs

On top of the original gbfr-logs feature set, this project adds:

- **Game v2.0.2 / expansion support** — updated hooks and game data for the expansion (new characters, quests, and items), plus correct player attribution and stun tracking in online multiplayer.
- **Damage cap tracking** — per-skill capped-hit counts and an exact overcap % column in the skill breakdown, read from the game's own damage-cap computation.
- **Expanded equipment tracking** — full loadouts for players and AI companions: weapons with uncap, awakening, wrightstones, and transcendence, innate weapon skills, sigils, overmasteries, master traits (skill board), and character stats.
- **Build checklist** — a Builds tab that checks each player's gear against a trait checklist (e.g. Damage Cap, Supplementary Damage), editable in Settings.
- **Conflux (Endless mode) support** — a dedicated Conflux tab that groups runs into rooms with per-room meters.
- **Toolbox: Synthesis Helper** — searches your sigil box for pairs that will synthesize into a target trait combination, using the game's actual synthesis logic.

## How to install

- Go to [Releases](https://github.com/villith/relink-logs/releases)
- Download the latest .msi installer and run it.
- Open Relink Logs after the game is already running.

## Found a translation problem or a bug?

You don't need any coding knowledge to help — just a GitHub account:

- [Report a wrong or missing translation](https://github.com/villith/relink-logs/issues/new?template=translation.yml) — fill in the form and we'll apply the fix.
- [Report a bug](https://github.com/villith/relink-logs/issues/new?template=bug.yml)

Note: item / weapon / skill names come from the game's own data files and can't be hand-edited — only the app's interface text can be changed.

## Frequently Asked Questions

> Q: I closed the meter, but it's still running?

When you close the windows, Relink Logs continues to run in your task tray in the bottom right of your desktop.

This task tray functionality is meant to give you more options for customizing:

- This lets you close the logs window, but be able to reopen it again later.
- You can toggle clickthrough of the overlay as well.

> Q: The meter isn't updating or displaying anything.

Try running the program after the game has been launched. Be sure to run the program as admin.

> Q: The application is not working / launching.

Relink Logs uses your built-in Microsoft Edge Webview2 Runtime to run the application. This keeps the app relatively small as we don't have to package in a browser.

However, you may have an out-of-date or missing "Webview2 Runtime":

- Install the latest one from Microsoft: <https://developer.microsoft.com/en-us/microsoft-edge/webview2/?form=MA13LH#download> (Evergreen Bootstrapper should work here)

> Q: Is this safe? My antivirus is marking the installation as a virus / malware.

As always, this is up to you to trust Relink Logs. The program can trigger false positive flags. There are reasons why it can give such alerts:

- Relink Logs does code DLL injection into the running game process which can look like a virus-like program.
- Relink Logs reads game memory and modifies game code at runtime in order to receive parser data.
- I recommend adding an exception / whitelisting for the installation folder so that your anti-virus does not delete it while your game is running, but you may not need to do so if you haven't ran into this issue.

See [how to add an exclusion to Windows Defender](https://support.microsoft.com/en-us/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26).

> Q: How do I update?

Launching the application will automatically check for new updates!

Same as with installing, you can download the [latest release](https://github.com/villith/relink-logs/releases) and run the installer again and it will update over your old installation.

> Q: How do I uninstall?

You can uninstall Relink Logs the normal way through the Control Panel or by running the uninstall script in the folder where you installed it to. You may also want to remove these folders.

- `%AppData%\gbfr-logs`

> Q: How do I add/edit my language?

Read [src-tauri/lang/README.md](./src-tauri/lang/README.md) for more information on how to add/edit language support!

> Q: My issue isn't listed here, or I have a suggestion.

Feel free to create a [new GitHub issue](https://github.com/villith/relink-logs/issues).

## For Developers

- Install nightly Rust ([rustup.rs](https://rustup.rs/)) + [Node.js](https://nodejs.org/en/download).
- Install NPM dependencies with `npm install`
- `npm run tauri dev`

## Under the hood

This project is split up into a few subprojects:

- `src-hook/` - Library that is injected into the game that broadcasts essential damage events.
- `src-tauri/` - The Tauri Rust backend that communicates with the hooked process and does parsing.
- `protocol/` - Defines the message protocol used by hook + back-end.
- `src/` - The JS front-end used by the Tauri web app

## Credits

This project would not have been possible without the following folks:

- [false-spring/gbfr-logs](https://github.com/false-spring/gbfr-logs) — the original project this one was built upon.
- [nyaoouo/GBFR-ACT](https://github.com/nyaoouo/GBFR-ACT) for the original reverse engineering work.
- [Harkain](https://github.com/Harkains) for their work on formatting and translating skills to friendly English names.

## Disclaimer

Please keep in mind that this tool is meant to improve the experience that Cygames has provided us and is not meant to cause them or anyone other players damage. Relink Logs modifies your running game client and is not guaranteed to work after game patches, in which case you may experience instability or crashes.
