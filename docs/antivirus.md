# "Hook file missing" — antivirus removed `hook.dll`

If Relink Logs shows **Hook file missing**, the file `hook.dll` is no longer in
the folder the app was installed to. Nearly always, antivirus software
quarantined it.

The app cannot measure anything without that file. It starts normally, finds
the game, and then sits there showing nothing — which is why it now tells you
outright instead of reporting "No game found".

## Why it gets flagged

`hook.dll` is injected into the running game and reads damage numbers out of
its memory. That is the same technique cheats use, so behaviour-based scanners
flag it on what it _does_, regardless of what it is. Both the installer and
`hook.dll` are Authenticode-signed, which helps with SmartScreen and with
reputation-based checks, but it cannot stop a behavioural detection.

It is a false positive. The app only reads the game's memory and never modifies
it, and every line of it is public at
<https://github.com/villith/relink-logs>.

## Fixing it

**The order matters.** Reinstalling first just gets the new copy quarantined
too, which is the loop most people get stuck in. Add the exclusion first.

### 1. Exclude the install folder

Exclude the **folder**, not the file — an update writes a new `hook.dll`, and a
file-level exclusion will not cover it.

The default install folder is:

```
C:\Program Files\GBFR Logs
```

(The folder still carries the old name — the app was renamed, the installer's
product name was not.)

**Windows Security (Defender)**

Start → Windows Security → Virus & threat protection → Manage settings →
Add or remove exclusions → Add an exclusion → Folder → pick the install folder.

**Other antivirus**

Look for "Exclusions", "Exceptions", "Allow list", or "Trusted files" in the
settings. If yours is not listed here, searching for
`<product name> add folder exclusion` will find the current steps.

### 2. Get the file back

Pick whichever is easier — both work once the exclusion is in place.

**Restore from quarantine.** Most antivirus keeps quarantined files for around
30 days and can put them back. In Windows Security: Virus & threat protection →
Protection history → find the `hook.dll` detection → Actions → Restore.

**Or repair the install.** Windows Installer notices the missing file and
replaces just that one, keeping your logs database:

```
msiexec /fom {path-to-the-msi-you-installed}
```

**Or reinstall.** Download the latest MSI from
[Releases](https://github.com/villith/relink-logs/releases/latest) and run it.
Your logs are stored separately and are not affected.

### 3. Confirm

Restart Relink Logs. The status should read **No game found** instead of
**Hook file missing**. Launch the game and it should connect as usual.

## If you extracted the MSI by hand

Extracting the MSI to a folder of your choosing works, but it skips the
installer, so nothing registers the app with Windows and a repair is not
available. Scanners also treat a loose folder in a user directory more
aggressively than a proper `Program Files` install. If you go this route, add
the exclusion for the folder you extracted to _before_ extracting.

## Help us get it un-flagged

Reporting the false positive is what eventually fixes it for everyone, and
vendors act on user reports:

- **Microsoft Defender** — submit the file at
  <https://www.microsoft.com/en-us/wdsi/filesubmission> as a false positive.
- **Other vendors** — search for `<product name> false positive submission`.

Please also [open an issue](https://github.com/villith/relink-logs/issues/new)
telling us which antivirus flagged it and what the detection was called. That
tells us which vendors to chase.
