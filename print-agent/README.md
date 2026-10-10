# matcami print agent

## 1. What it is

The print agent is the small local program that owns the receipt printer, the kitchen printer and
the cash drawer (spec 11). The browser never talks to hardware: the till sends a finished receipt or
kitchen ticket to the agent as plain text lines, and the agent turns it into ESC/POS bytes, sends it
to the printer, and opens the drawer on a cash sale. From version 2, a receipt may also carry the
restaurant's logo as a small black-and-white picture. The agent accepts it only in an exact, checked
size — its shape and its byte count, not the dots themselves — and prints it with printer commands
it writes itself (sections 9 and 10). It runs on the **same PC as the till's Chrome**
and listens on `127.0.0.1` only — nothing on the network can reach it, and the till must present its
pairing secret on every request. Nobody types that secret: the owner presses **Pair this till** on
the till's Printer screen and the agent hands it over, once (section 5).

If a printer is off or out of paper, jobs wait on disk and print when it recovers. The drawer never
opens late: a pulse the agent could not send is refused, not retried.

## 2. What you need

- **A Windows 10/11, Linux or Mac PC that runs the till in Chrome, and a receipt printer** — either
  plugged into that PC by USB and set up in the PC's own printer settings, or a network printer with
  a fixed IP address (TCP 9100). Nothing to install beforehand — the download carries everything it
  needs.
- Paper width decides the column count: 58 mm paper is `32` columns, 80 mm paper is `48`. Port 9100
  is the raw printing port every Epson-compatible network printer offers.
- **Chrome** version 142 or later shows a one-time local-network permission prompt (section 5).

## 3. Install

1. On the till PC, open the matcami dashboard → **POS device** → **Print agent** (or, on the till,
   signed in as the owner: **Printer**) and download the file for this PC. The page shows each
   file's SHA-256, in case you want to compare it. A file marked `◆ Not yet checked on …` has not
   yet been tried on that kind of PC: it installs the same way, and if it does not start, say so
   to whoever runs your matcami server.
2. Run it. The files are not signed yet, so the first run asks you to confirm it:
   - **Windows:** If Windows says it protected your PC, choose More info → Run anyway.
   - **Mac:** Double-click the zip, then double-click matcami-print-agent. If the Mac blocks it,
     open System Settings → Privacy & Security and choose Open Anyway.
   - **Linux:** Unzip it, then run matcami-print-agent (or right-click → Properties → allow
     executing, then double-click).

   The agent starts when this PC signs in. Then, on the till, sign in as the owner → Printer → Pair
   this till.

3. What it does, listing each step in its window:
   - copies itself into a folder of your own user account — the program in `bin/`, the settings in
     `config.json`, the waiting jobs and the log in `data/`:

     | PC      | Folder                                                                 |
     | ------- | ---------------------------------------------------------------------- |
     | Windows | `%LOCALAPPDATA%\matcami\print-agent`                                   |
     | Mac     | `~/Library/Application Support/matcami/print-agent`                    |
     | Linux   | `~/.local/share/matcami/print-agent` (or `$XDG_DATA_HOME/matcami/...`) |

   - makes itself start at every sign-in: a Task Scheduler task named **matcami print agent**
     (Windows), a `systemd --user` unit `matcami-print-agent` (Linux), a LaunchAgent
     `com.matcami.print-agent` (Mac);
   - opens pairing for one till;
   - opens its setup page in the browser.

4. On the setup page, or later on the till's Printer page, say where the receipt printer is —
   **plugged into this PC** (pick it from the list) or **on the network** (enter its IP address;
   add `:port` if it does not use 9100) — choose the paper width, and press **Save printers**. A
   separate kitchen printer is optional: without one, kitchen tickets print on the receipt printer.

   A USB printer must appear in the PC's own printer list first; the agent prints through the PC's
   print service, so it needs no rights of its own:
   - **Linux:** usually added by itself when plugged in (Printers in the system settings).
   - **Mac:** System Settings → Printers & Scanners → Add Printer.
   - **Windows:** install the maker's driver, or add it in Printers & scanners with the
     "Generic / Text Only" driver. Not yet tried on Windows: tell whoever runs your server how it
     went.

5. On the till, as the owner: **Printer** → **Pair this till** → allow local network access when
   Chrome asks → **Test print**.

The setup page lives at `http://127.0.0.1:9471/setup` and opens only with the key the installer
hands it. To open it again, run the downloaded file again: it keeps everything (section 9) and opens
the page. Besides the printers, it shows whether the agent answers the app (`● Answers <address>`),
prints a test page, opens pairing, and under **Advanced** changes the app address or resets the
pairing key.

**The file answers one app address only** — the one it was downloaded from, written into it when the
server built it. Download it from the address the till opens in Chrome.

`config.json` is written by the installer and changed by the setup page and the till's Printer page;
there is no need to open it. Its fields:

| Field              | Meaning                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`           | The till's address exactly as Chrome shows it, scheme and host only. Must be `https:`; `http:` is accepted for `localhost` and `127.0.0.1` only.                  |
| `token`            | The pairing secret: 64 lowercase hex characters, minted on this PC at install.                                                                                    |
| `setupSecret`      | The setup page's key: 64 lowercase hex characters, minted on this PC at install.                                                                                  |
| `port`             | The loopback port the agent listens on (default 9471).                                                                                                            |
| `printers.receipt` | The receipt printer, or `null` until one is entered: `name` and `width` (32 or 48) for a printer on this PC; `host`, `port` (9100) and `width` for a network one. |
| `printers.kitchen` | The same for the kitchen printer, or `null` for none.                                                                                                             |
| `dataDir`          | Where the job queue, the seen-id store and `agent.log` live.                                                                                                      |

On Linux and Mac the file is mode `0600` — readable by your user only. Windows has no such mode; the
folder sits inside your own user profile, where other accounts cannot read it. The secrets are
never printed to a log.

## 4. Start automatically

Done by the installer; nothing to set up. No administrator rights are needed.

On Windows a console window may flash for under a second at sign-in; the agent then runs with no
window. To check that it is registered: Task Scheduler → **matcami print agent** (Windows),
`systemctl --user status matcami-print-agent` (Linux), or
`launchctl print gui/$(id -u)/com.matcami.print-agent` (Mac).

## 5. Pair the till

The agent must be running — the installer starts it, and it starts at every sign-in after that.

1. On the till PC, the **owner** opens the till in Chrome and signs in with their PIN.
2. Open the employee menu → **Printer**.
3. Press **Pair this till**. Chrome asks whether the site may access devices on this computer
   (Chrome 142 and later): answer **Allow**. The screen reads
   `Paired with the agent at http://127.0.0.1:9471`.
4. Press **Test print**. The receipt printer prints a test page and the status chip turns to
   `● Printer ready`. If the chip reads `◆ Printer address not set`, enter the printer first
   (section 3, step 4).

**Pairing is open from the install until one till pairs** — the first to ask — and then it closes;
there is no time limit. If the screen says `○ Pairing is closed`, run the print agent file again
and press **Open pairing for a till** on its setup page, then press **Pair this till** once more.

If the screen says `✕ Pairing was already used` and you did **not** pair a till since the agent was
installed, something else on this PC asked first and now holds the secret: on the setup page choose
**Advanced → Reset the pairing key**, then open pairing and pair again. That is the trade this button
makes — while pairing is open, any program on the till PC can ask before the till does, and pairing
that is opened and never used stays open — which is why it is single-use and tells you when it was
taken. Pair the till soon after opening pairing.

**Pairing without opening anything.** From a terminal on the till PC, the installed program's
`link` command (`matcami-print-agent link`, in the `bin/` folder of section 3) prints a link to the
till's Printer screen that carries the agent address and the secret after the `#` — the part of an
address a browser never sends to any server. Open it once in the till's Chrome (the owner signs in
if nobody is) and the till pairs itself; the till removes the secret from the address bar at once,
though the link stays in that Chrome profile's history. Use it when the agent is not on port 9471:
**Pair this till** asks port 9471, or the agent the till was last paired with. Treat the link as the
secret it carries: never into git, a chat message or a screenshot.

If the prompt was dismissed or blocked, the chip reads `✕ Printing blocked by Chrome`. To fix it:
Chrome → **Settings** → **Privacy and security** → **Site settings** → find the till's address →
**Local network access** (some versions call it **Apps and services on this device**) → **Allow**,
then reload the till.

On a **managed** Chrome (enterprise policies), the permission can be pre-granted for the till's
address so no prompt appears: the policies are `LocalNetworkAccessAllowedForUrls` and, from Chrome
145 where loopback is split out, `LoopbackNetworkAccessAllowedForUrls`. Confirm the exact names in
Chrome's policy list (`chrome://policy`) for the installed version before rolling them out.

Pairing lives in the till's own browser storage. **Forget pairing** on the Printer screen removes
it; **Reset the pairing key** on the setup page also invalidates it, and the till must be paired
again.

## 6. Network safety

Put the printers on a **staff-only network**. Anything that can open a TCP connection to port 9100
on a printer can print on it and open the drawer **without** the agent — the pairing secret protects
the agent, not the printer. Guest Wi-Fi must not route to the printers' addresses, and the printers
should not be reachable from the internet. The agent itself binds `127.0.0.1` only, so no firewall
rule is needed for it.

## 7. What the status chip means

The till shows one chip for printing, always with a glyph so colour never carries the meaning alone:

| Chip                                                           | Meaning                                                                                                                                            | Fix                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `● Printer ready` (· _n_ waiting)                              | The agent answers and the printer accepts connections; _n_ jobs are queued.                                                                        | —                                                                                                                                                                               |
| `◆ Update the print agent to print the logo` (· _n_ waiting)   | The owner set a receipt logo, but this agent is version 1. Every receipt still prints in full, without the logo.                                   | Section 9 (update the agent).                                                                                                                                                   |
| `◆ Test-print the logo before receipts use it` (· _n_ waiting) | The agent is version 2, but this logo's test print is not confirmed on this till at present. Every receipt still prints in full, without the logo. | Section 10.                                                                                                                                                                     |
| `◆ Printer address not set — open Printer`                     | The agent answers, but no receipt printer has been entered yet.                                                                                    | Printer → enter the address and paper width → **Save printers** (section 3, step 4).                                                                                            |
| `◆ Printer unreachable`                                        | The agent is not running, or the printer is off, unplugged, has a different IP, or (USB) the PC's print service has stopped it.                    | Run the downloaded file again (it starts the agent), then check the printer's power and cable; for a USB printer, open the PC's printer settings and resume it if it is paused. |
| `✕ Printing blocked by Chrome`                                 | Chrome denied local network access for the till's address.                                                                                         | Section 5, Chrome paragraph.                                                                                                                                                    |
| `✕ Printer pairing is wrong`                                   | The pairing key was reset on the agent (setup page → Advanced), or the agent was set up again, after this till was paired.                         | Printer → **Forget pairing**, then pair again (section 5).                                                                                                                      |
| `○ Printer not set up`                                         | The till has never been paired.                                                                                                                    | Section 5.                                                                                                                                                                      |

## 8. Paper out and outages

- Jobs that cannot print wait in the `data/queue/` folder (one file per job; section 3 says where)
  and print, in order, when the printer comes back. When the printer reports its paper sensor, a
  roll that has run out pauses the queue until paper is loaded. Sales are never blocked by printing.
- The **drawer never opens late**. A pulse the agent could not deliver within the sale's first 30
  seconds is refused, and it is never queued or retried — a queued pulse would be a drawer that opens
  by itself when the printer comes back.
- Any receipt or kitchen ticket can be reprinted from **Sales** on the till. A reprint is marked
  `COPY` (spec 11), and the agent prints each job id at most once, so a retry of the same print is
  ignored rather than duplicated.
- The paper width cannot be changed while that printer has jobs waiting: they are already laid out
  for the old width. Let them print, or reconnect the printer, then change it.
- A USB printer's waiting receipts sit in the PC's own print queue (the agent counts them in
  `waiting`), and print when the printer is back. The drawer is different: a pulse the PC's print
  service has not printed within 15 seconds of the sale (behind that sale's receipt and ticket) is
  taken back, so the drawer never opens late. If it cannot be taken back, `agent.log` says
  `DRAWER PULSE … COULD NOT BE CANCELLED`: remove that job from the PC's print queue.
- A receipt that was waiting when the receipt printer's address changed prints on the new printer
  in full, but without the logo: the logo is checked on one printer (section 10), and the new one
  has not been checked yet.

## 9. Updating

Download the new file from the dashboard and run it. It stops the running agent, replaces it, and
keeps the settings, the pairing and every receipt waiting to print. After changing the app's
address, download and run the new file on every till PC: the installer answers only the address it
was built for.

**Version 2 — the receipt logo.** Version 2 adds the receipt logo. The till asks the agent for its
version and sends a logo only to version 2 or later; until then every receipt prints in full without
the logo, and the printer chip reads `◆ Update the print agent to print the logo` (section 7).
Update the agent on the till PC **before** uploading a logo on the dashboard. The update keeps the
settings — and with them the pairing, so no new pairing is needed — and the waiting jobs, which
print normally afterwards. After the update, reload the till: the update chip disappears. If a logo
is already set, the chip then reads `◆ Test-print the logo before receipts use it` until the logo is
checked (section 10).

## 10. Checking the logo

The agent prints the logo with the ESC/POS image command `GS v 0`, which Epson marks obsolete and
not every printer understands. Only a test print on the restaurant's own printer shows whether this
one does, so receipts carry the logo only after the owner has checked it:

1. On the dashboard, the owner uploads the logo on **Settings → Receipt** (`/settings/receipt`). It
   is converted to black and white, at most 384 dots wide and 160 dots tall (about 48 × 20 mm), so
   it fits 58 mm and 80 mm paper; the agent centres it.
2. On the till, while it is online, go back to the employee screen (employee menu →
   **Switch employee**), or reload that screen if the till is already showing it. The employee
   screen downloads the till's settings, and the logo with them.
3. Sign in as the owner, open the employee menu → **Printer** and press **Test print**. The receipt
   printer's test page should start with the logo, and the results under the button include
   `● The logo was sent — it should print at the top of the receipt test page.` If they say
   `◆ The logo was left off — update the print agent on this PC to version 2` instead, update the
   agent first (section 9). If the screen says `● Test page sent to the receipt printer` and neither
   of those lines, the till has no logo yet: repeat step 2.
4. If the logo printed correctly, press **The logo printed correctly** under the result; the screen
   reads `● Receipts will print the logo`. Receipts carry the logo only after that confirmation, and
   a new or changed logo needs a new test print and a new confirmation; until then the printer chip
   reads `◆ Test-print the logo before receipts use it`.
5. If the paper shows garbage characters, random dots, or nothing where the logo should be, press
   **It did not print correctly**: the printer does not support the `GS v 0` image command. Remove
   the logo on **Settings → Receipt** at once, then bring the till back to the employee screen while
   it is online (step 2) so it drops its copy. Receipts print exactly as before either way, because
   an unconfirmed logo never reaches a receipt. Removing it matters all the same: a printer that
   does not understand the logo command can read the picture's dots as text or as printer commands,
   and every test page from this till still carries the logo.
6. Repeat the check after replacing or re-configuring the printer. The confirmation belongs to the
   receipt printer it was watched on — its address and paper width — so the till asks for it again
   by itself when that printer changes, on the till's Printer page or on the agent's setup page, and
   when the till is re-registered or its pairing changes (**Forget pairing**, **Pair this till** or
   the agent's link, section 5). Its receipts print without the logo until a test print is
   confirmed again (step 4). A different printer put in at the same address with the same paper
   width goes unnoticed: this till's receipts keep carrying the logo until the check is repeated.
   If the logo does not print correctly there, press **It did not print correctly**: this till's
   receipts print without the logo from then on, until a test print is confirmed again. Removing
   the logo on **Settings → Receipt** is still how to take it off every till, and off this till's
   test pages; then bring each till back to the employee screen while it is online (step 2).

## 11. Logs

`data/agent.log` (in the folder of section 3) holds one line per printed job and per drawer pulse,
for example:

```
2026-09-29T07:09:42.355Z drawer 6f1d…:drawer
2026-09-29T07:09:43.315Z printed 6f1d…:receipt:0
2026-09-29T07:09:43.336Z printed 6f1d…:kitchen:0
```

Retries are logged too (`retry receipt in 2000 ms: …`). Request bodies, the pairing secret and the
setup key are never written to the log.

## 12. Uninstall

Run the downloaded file with `uninstall` — from a terminal or a Windows Command Prompt, for example
`matcami-print-agent-windows-x64.exe uninstall` in the Downloads folder, or the installed
`bin/matcami-print-agent uninstall`. It stops the agent, removes the sign-in start and the program,
and keeps the settings folder of section 3 (the settings, the pairing and any waiting jobs), so a
later install picks up where this one left off. Delete that folder to remove everything; every till
must then pair again.

## 13. For developers: running from source

The repository's `print-agent/src/` is the same program, run by Node **24.21.0** (the version
`.nvmrc` pins) with no dependencies and no build step. It is what the vitest `print-agent` project
and the e2e journeys run. From the repository root:

```bash
node print-agent/src/main.ts init --origin https://pos.example.com \
  --receipt 192.168.10.50 --width 48 \
  --kitchen 192.168.10.51 --kitchen-width 32   # writes print-agent/config.json, opens pairing
node print-agent/src/main.ts pair              # opens pairing again
node print-agent/src/main.ts link              # prints a pairing link (it carries the secret)
node print-agent/src/main.ts run               # listens on http://127.0.0.1:9471
node print-agent/src/main.ts --version         # "matcami print agent 2 (source)"
```

`--receipt` and `--width` are optional: without them the agent starts with no printer, and the till's
Printer page sets one. A printer on this PC is `--receipt local:<its name in lpstat -p>`. `init` refuses to overwrite an existing `config.json` without `--force`, which
mints a new secret (every till pairs again). `config.example.json` shows a finished file; from
source, `dataDir` defaults to `print-agent/data`. On Linux and Mac `init` writes the file with mode
`0600`; on Windows keep the checkout inside the user's own profile.
`node print-agent/src/main.ts setup` opens the setup page of an agent that is already running.

### Building the installers

```bash
pnpm build:print-agent [--origin <url>] [--targets <list>] [--smoke] [--force]
```

It bundles `print-agent/src` with esbuild, makes a Node single-executable blob, and injects it into
the official Node 24.21.0 binary of each target (`linux-x64`, `windows-x64`, `macos-x64`,
`macos-arm64`; downloaded once into `.cache/print-agent` and checked against pinned SHA-256 values).
The Mac binaries get an ad-hoc signature. The app origin comes from `--origin`, else `.env`'s
`ORIGIN`, and is written into each file. The output and its `manifest.json` go to
`dist/print-agent/current/` (the previous set is kept in `previous/`), which the app serves at
`/downloads/print-agent`. A full build whose bundled agent and origin are unchanged is skipped
unless `--force`. `--smoke` runs the Linux installer for real before publishing — its `--version`
and one start of the agent — and a set that fails it never reaches `current/`. `scripts/deploy.sh`
runs it on every deploy.

### Auto-start from source (running from source only)

The installer registers auto-start by itself. A source checkout run as a service needs it by hand.

**Linux (systemd).** Create `/etc/systemd/system/matcami-print-agent.service`. `WorkingDirectory`
is the **parent** of the `print-agent/` folder, `User` is a normal (non-root) account that owns that
folder, and `ExecStart` names the Node 24 binary — `which node` shows its path if it is not
`/usr/bin/node`:

```ini
[Unit]
Description=matcami print agent (receipts, kitchen tickets, cash drawer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=matcami
WorkingDirectory=/opt/matcami
ExecStart=/usr/bin/node print-agent/src/main.ts run
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/matcami/print-agent

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo chown -R matcami:matcami /opt/matcami/print-agent
sudo systemctl daemon-reload
sudo systemctl enable --now matcami-print-agent
systemctl status matcami-print-agent        # "active (running)"
journalctl -u matcami-print-agent -f        # the agent's own output
```

**Windows (Task Scheduler).**

1. Open **Task Scheduler** → **Create Task…** (not "Basic").
2. **General**: name `matcami print agent`; tick **Run only when user is logged on** (Chrome runs in
   the same session); tick **Hidden**.
3. **Triggers** → New: **At log on**, for the till's user.
4. **Actions** → New: **Start a program**.
   - Program/script: `node.exe` (or the full path, e.g. `C:\Program Files\nodejs\node.exe`)
   - Add arguments: `print-agent\src\main.ts run`
   - Start in: `C:\Users\<till user>\matcami` (the **parent** of the `print-agent` folder)
5. **Settings**: tick **If the task fails, restart every: 1 minute**, attempts `999`; untick **Stop
   the task if it runs longer than**.
6. **OK**, then right-click the task → **Run**. A browser tab at `http://127.0.0.1:9471/status`
   shows `{"error":"bad_origin"}` — that means the agent is up and correctly refusing a request that
   did not come from the till.

**Updating from source:** replace `print-agent/src/` with the new version and restart the service
(`sudo systemctl restart matcami-print-agent`, or end and re-run the scheduled task).
`config.json` and `data/` are kept.
