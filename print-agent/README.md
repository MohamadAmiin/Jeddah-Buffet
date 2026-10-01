# matcami print agent

## 1. What it is

The print agent is the small local program that owns the receipt printer, the kitchen printer and
the cash drawer (spec 11). The browser never talks to hardware: the till sends a finished receipt or
kitchen ticket to the agent as plain text lines, and the agent turns it into ESC/POS bytes, sends it
to the printer, and opens the drawer on a cash sale. It runs on the **same PC as the till's Chrome**
and listens on `127.0.0.1` only — nothing on the network can reach it, and the till must present its
pairing secret on every request. Nobody types that secret: the owner presses **Pair this till** on
the till's Printer screen and the agent hands it over, once (section 5).

If a printer is off or out of paper, jobs wait on disk and print when it recovers. The drawer never
opens late: a pulse the agent could not send is refused, not retried.

## 2. Requirements

- **Node.js 24.21.0** on the till PC (the same version the repository pins in `.nvmrc`). Nothing
  else is installed — the agent has no dependencies and no build step.
- **Network ESC/POS printers** with **fixed IP addresses**, listening on TCP port 9100 (the raw
  printing port every Epson-compatible network printer offers). Paper width decides the column
  count: 58 mm paper is `32` columns, 80 mm paper is `48`.
- **Chrome** on the till PC (version 142 or later shows the one-time local-network permission
  prompt described in section 5).

## 3. Install

1. Copy the repository's `print-agent/` folder to the till PC, for example to
   `/opt/matcami/print-agent` (Linux) or `C:\Users\<till user>\matcami\print-agent` (Windows). Only `src/` is needed
   from the repository; `config.json` and `data/` are created on the PC.

2. Write the configuration and mint the pairing secret. Replace the address with the exact address
   the till opens in Chrome, and the IPs with your printers':

   ```bash
   cd /opt/matcami
   node print-agent/src/main.ts init \
     --origin https://pos.example.com \
     --receipt 192.168.10.50 --width 48 \
     --kitchen 192.168.10.51 --kitchen-width 32
   ```

   Leave out `--kitchen` when there is one printer: kitchen tickets then print on the receipt
   printer. Add `:port` to a printer address if it is not 9100.

   The command writes `print-agent/config.json` and opens pairing:

   ```
   Wrote /opt/matcami/print-agent/config.json
   Agent URL:     http://127.0.0.1:9471
   Pairing is open until one till pairs.
   On the till, signed in as the owner: Printer → "Pair this till".
   ```

   On Linux and macOS the file is set to mode `0600` — readable by your user only — on every
   `init`, including `--force` over an existing file. Windows has no such mode: keep the
   `print-agent` folder inside the till user's own profile (for example
   `C:\Users\<till user>\matcami\print-agent`), where other accounts cannot read it, rather than
   directly under `C:\`.

   Nothing here needs keeping: the pairing secret stays in `config.json` and is never printed by
   `init`. To replace it, run `init` again with `--force` and pair the till again.

3. Try it once by hand before making it a service:

   ```bash
   node print-agent/src/main.ts run
   # matcami print agent listening on http://127.0.0.1:9471
   ```

   Stop it with Ctrl-C.

`config.example.json` shows the finished file. Its fields:

| Field              | Meaning                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `origin`           | The till's address exactly as Chrome shows it, scheme and host only. Must be `https:`; `http:` is accepted for `localhost` and `127.0.0.1` only. |
| `token`            | 64 lowercase hex characters, written by `init`.                                                                                                  |
| `port`             | The loopback port the agent listens on (default 9471).                                                                                           |
| `printers.receipt` | `host`, `port` (9100) and `width` (32 or 48) of the receipt printer.                                                                             |
| `printers.kitchen` | The same for the kitchen printer, or `null` for none.                                                                                            |
| `dataDir`          | Where the job queue, the seen-id store and `agent.log` live (default `print-agent/data`).                                                        |

## 4. Start automatically

### Linux (systemd)

Create `/etc/systemd/system/matcami-print-agent.service`. `WorkingDirectory` is the **parent** of
the `print-agent/` folder, `User` is a normal (non-root) account that owns that folder, and
`ExecStart` names the Node 24 binary — `which node` shows its path if it is not `/usr/bin/node`:

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
ReadWritePaths=/opt/matcami/print-agent/data

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

### Windows (Task Scheduler)

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

## 5. Pair the till

The agent must be running (section 3 step 3, or the service from section 4).

1. On the till PC, the **owner** opens the till in Chrome and signs in with their PIN.
2. Open the employee menu → **Printer**.
3. Press **Pair this till**. Chrome asks whether the site may access devices on this computer
   (Chrome 142 and later): answer **Allow**. The screen reads
   `Paired with the agent at http://127.0.0.1:9471`.
4. Press **Test print**. The receipt printer prints a test page and the status chip turns to
   `● Printer ready`.

**Pairing is open from `init` until one till pairs** — the first to ask — and then it closes; there
is no time limit. If the screen says `○ Pairing is closed`, open it again on the till PC and press
**Pair this till** once more:

```bash
node print-agent/src/main.ts pair
```

If the screen says `✕ Pairing was already used` and you did **not** pair a till since the agent was
set up, something else on this PC asked first and now holds the secret: replace it with
`init --force` (section 3) and pair again. That is the trade this button makes — while pairing is
open, any program on the till PC can ask before the till does, and pairing that is opened and never
used stays open — which is why it is single-use and tells you when it was taken. Pair the till
soon after opening pairing.

**Pairing without opening anything.** `node print-agent/src/main.ts link` prints a link to the
till's Printer screen that carries the agent address and the secret after the `#` — the part of an
address a browser never sends to any server. Open it once in the till's Chrome (the owner signs in
if nobody is) and the till pairs itself; the till removes the secret from the address bar at once,
though the link stays in that Chrome profile's history. Use it when the agent is not on port 9471
(`--port`): **Pair this till** asks port 9471, or the agent the till was last paired with. Treat the
link as the secret it carries: never into git, a chat message or a screenshot.

If the prompt was dismissed or blocked, the chip reads `✕ Printing blocked by Chrome`. To fix it:
Chrome → **Settings** → **Privacy and security** → **Site settings** → find the till's address →
**Local network access** (some versions call it **Apps and services on this device**) → **Allow**,
then reload the till.

On a **managed** Chrome (enterprise policies), the permission can be pre-granted for the till's
address so no prompt appears: the policies are `LocalNetworkAccessAllowedForUrls` and, from Chrome
145 where loopback is split out, `LoopbackNetworkAccessAllowedForUrls`. Confirm the exact names in
Chrome's policy list (`chrome://policy`) for the installed version before rolling them out.

Pairing lives in the till's own browser storage. **Forget pairing** on the Printer screen removes
it; re-running `init --force` on the agent PC also invalidates it, and the till must be paired again.

## 6. Network safety

Put the printers on a **staff-only network**. Anything that can open a TCP connection to port 9100
on a printer can print on it and open the drawer **without** the agent — the pairing secret protects
the agent, not the printer. Guest Wi-Fi must not route to the printers' addresses, and the printers
should not be reachable from the internet. The agent itself binds `127.0.0.1` only, so no firewall
rule is needed for it.

## 7. What the status chip means

The till shows one chip for printing, always with a glyph so colour never carries the meaning alone:

| Chip                              | Meaning                                                                     | Fix                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `● Printer ready` (· _n_ waiting) | The agent answers and the printer accepts connections; _n_ jobs are queued. | —                                                                                                        |
| `◆ Printer unreachable`           | The agent is stopped, or the printer is off or has a different IP.          | Section 4 (`systemctl status …`), then check the printer's power, network cable and IP in `config.json`. |
| `✕ Printing blocked by Chrome`    | Chrome denied local network access for the till's address.                  | Section 5, second paragraph.                                                                             |
| `✕ Printer pairing is wrong`      | The agent was set up again (`init --force`) after this till was paired.     | Printer → **Forget pairing**, then pair again (section 5).                                               |
| `○ Printer not set up`            | The till has never been paired.                                             | Section 5.                                                                                               |

## 8. Paper out and outages

- Jobs that cannot print wait in `print-agent/data/queue/` (one file per job) and print, in order,
  when the printer comes back. When the printer reports its paper sensor, a roll that has run out
  pauses the queue until paper is loaded. Sales are never blocked by printing.
- The **drawer never opens late**. A pulse the agent could not deliver within the sale's first 30
  seconds is refused, and it is never queued or retried — a queued pulse would be a drawer that opens
  by itself when the printer comes back.
- Any receipt or kitchen ticket can be reprinted from **Sales** on the till. A reprint is marked
  `COPY` (spec 11), and the agent prints each job id at most once, so a retry of the same print is
  ignored rather than duplicated.

## 9. Updating

Replace `print-agent/src/` with the new version and restart the service (`sudo systemctl restart
matcami-print-agent`, or end and re-run the scheduled task). `config.json` and `data/` are kept.

## 10. Logs

`print-agent/data/agent.log` holds one line per printed job and per drawer pulse, for example:

```
2026-09-29T07:09:42.355Z drawer 6f1d…:drawer
2026-09-29T07:09:43.315Z printed 6f1d…:receipt:0
2026-09-29T07:09:43.336Z printed 6f1d…:kitchen:0
```

Retries are logged too (`retry receipt in 2000 ms: …`). Request bodies and the token are never
written to the log.
