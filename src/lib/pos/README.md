# `pos/` — IndexedDB, sync queue, service worker, invoice sequence, print agent

IndexedDB, sync queue, service worker, device invoice sequence, print-agent
client. **Must work offline.**

## The one hard rule

**Must never import `$lib/server/**`.** SvelteKit build-blocks server modules
from the browser, so such an import cannot work offline — and this directory is
ordinary TypeScript that either side may import, so SvelteKit's own guard does
not police it. `eslint.config.js` enforces the boundary here with
`no-restricted-imports`.

If you need logic shared with the server — money arithmetic, for example — move
the pure function into an isomorphic module both sides import. Do **not** copy
it: spec 17 requires one rounding rule, in one function, used by POS, server and
reports.

## What the offline path guarantees

- **A completed offline CASH sale is a recorded FACT, not a request the server
  may reject.** Price and tax rate at time of sale win; stock may go negative; a
  synced sale that fails validation is stored and flagged for owner review,
  never discarded (invariant 5).
- Every queued operation carries a **device-generated idempotency key**, and a
  retry MUST be a no-op.
- Invoice numbers come from the device's own gap-free sequence
  (`POS1-000001`), online or offline. The server enforces
  `UNIQUE (device_id, invoice_number)`, never renumbers. No global sequence, no
  `max(number)+1`.
- Card and mobile payments are NEVER auto-completed offline unless the
  provider/terminal explicitly supports offline authorization. House rule for
  that case: fail closed — no receipt, no invoice number, no Payment Clearing
  posting, order stays BILLED.
- Protect unsynced work: `navigator.storage.persist()`, the unsynced count
  always on screen, and logout and POS session close BLOCKED while the queue is
  non-empty.
- Menu sync is full-snapshot only: compare an integer against
  `/api/menu/version` and, on a mismatch, download the FULL snapshot and replace
  the local copy. No change-only sync.
- The browser NEVER talks to hardware. The print agent (`print-agent/`) owns the
  printers and the drawer; the till reaches it over local HTTP on `127.0.0.1`.
- **Printing never holds up a sale** (invariant 4): it starts after `completeSale`
  has resolved and is never awaited before `● Paid`. `orders.ts` imports neither
  `printing.ts` nor `print-client.ts`, and a test pins that.
- **A card or mobile sale prints nothing until the server confirms it**
  (invariant 5) — every print path asks `canPrint` first.
- **The drawer opens once, for a cash original, within 30 s of the sale**
  (invariant 9) — never on a reprint, never in a catch-up.

## Stores and modules

The IndexedDB database is `matcami-pos`, `DB_VERSION = 3`.

| Store              | keyPath      | Owning module           | Cleared by `bindDevice` / `forgetDevice`?                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employees`        | `id`         | `store.ts`              | yes — a per-device cache of the staff bundle                                                                                                                                                                                                                                                                                                    |
| `settings`         | `key`        | `store.ts`              | yes — including `printAgentUrl` and `printAgentToken` (the pairing), on purpose: a re-registered till pairs again; and `paymentMethods`, `receiptLayout` and `receiptLogo` (`settings.ts`), so a re-registered till keeps no other restaurant's methods, layout or logo; and `receiptLogoConfirmed`, so it asks for the logo's test print again |
| `menu`             | `id`         | `menu-snapshot.ts`      | yes                                                                                                                                                                                                                                                                                                                                             |
| `offline_logins`   | `clientOpId` | `store.ts` + `queue.ts` | NEVER — unsynced audit facts                                                                                                                                                                                                                                                                                                                    |
| `orders`           | `id`         | `orders.ts`             | NEVER — completed sales are facts, pruned only 30 days after they sync; a completed row carries `sale` (the queued payload, line amounts, cashier, business date) and `printed` marks (`receiptAt`, `kitchenAt`, `drawerAt`, `reprints`)                                                                                                        |
| `sync_queue`       | `clientOpId` | `queue.ts`              | NEVER — the queue IS the unsynced work                                                                                                                                                                                                                                                                                                          |
| `invoice_sequence` | `deviceId`   | `invoice-sequence.ts`   | NEVER — a rewind would reissue a number already queued; resume point `max(local counter, highest queued number for that device, server hint)`                                                                                                                                                                                                   |
| `session`          | `deviceId`   | `session.ts`            | NEVER — the open session's business date belongs to queued sales                                                                                                                                                                                                                                                                                |

A wipe protects a stolen or re-registered tablet's PIN hashes and menu, but the facts already
recorded on it belong to the restaurant's books and are never the wipe's to lose (spec 6,
invariant 5).

- `queue.ts` — FIFO by device seq, one op per request, backoff with the same `clientOpId` on
  network errors; `accepted`, `recorded_flagged` and `unrecorded` all advance; 409
  `foreign_device` parks; a device 403 stops the flush and forgets the device.
- `employee.svelte.ts` — the signed-in state; its mirror lives in `sessionStorage` with
  `lastActiveAt` and refuses to restore past the idle limit — NEVER `localStorage`.
- `idle.ts` — the idle watch; `null` seconds is inert, never a default.
- `menu-snapshot.ts` — parses the full menu snapshot; amounts stay decimal strings until
  `readMenu` converts them with `BigInt`; format 2 carries each item's resolved named rate; a
  cached copy in another format is replaced at the next version check.
- `settings.ts` — the cached payment methods, receipt layout and logo (keys `paymentMethods`,
  `receiptLayout`, `receiptLogo`); readers fall back safely (no methods → `[]`; no layout → the
  default with a pre-plan `receiptFooter` as footer line 1; a bad logo → null); the logo's bytes
  are cached so printing never touches the network, and fetched only when the bundle's
  fingerprint changes. Also the logo confirmation key `receiptLogoConfirmed`
  (`confirmReceiptLogo` / `readConfirmedLogoSha`): the sha256 of the logo the owner watched print
  correctly on a test page, withdrawn (`withdrawReceiptLogoConfirmation`) by "It did not print
  correctly" (whatever logo was confirmed: the printer cannot print one) and by every pairing
  saved or forgotten (`print-client.ts`).
- `menu-view.ts` — pure helpers over the cached menu: category tabs (an item with no category
  sits under the synthetic `Other` tab), the resolved tax rate, modifier groups, `formatTaxRate`.
- `photo-warmup.ts` — after every menu sync, fetches each photo once so the browser's HTTP cache
  holds it for offline use (best effort — never a service-worker cache).
- `can-print.ts` — THE rule for what may print: a completed cash sale always; card and mobile
  only once the server said `accepted` or `recorded_flagged` (fail closed).
- `tenders.ts` — the pay screen's tender list from the cached named methods (Cash always first,
  synthetic when the cache has none) and THE offline rule: card and mobile kinds are disabled
  offline with the reason in words; everything decides by kind, never by name.
- `receipt.ts` — the receipt, kitchen-ticket and test-page formatter. Pure: the sale's STORED
  snapshot and the cached layout in, lines of printable ASCII out, plus at most one 1-bit logo
  image line first on a receipt (and on the receipt printer's test page), 32 or 48 columns; it
  computes nothing. The layout's header and footer lines and its switches shape the receipt; the
  lines that may never be hidden (Settings 4) are enforced here, not in the database. The tax
  lines print the stored rate names and the sale's stored per-rate rows (`taxBreakdown`, else one
  mixed-rates line), the payment line the stored method name, and the payment-numbers block the
  enabled methods' merchant numbers.
- `print-client.ts` — the loopback agent client: the pairing settings (a loopback address and a
  64-hex token, in IndexedDB, never `localStorage`), obtained from the agent itself
  (`requestPairing`, answered once while the agent's pairing is open) or read from the
  agent's pairing link (`parsePairingFragment`; a link opened before the owner signs in waits in
  memory only) — nothing is typed — `agentStatus`, `submitJob`, `pulseDrawer`,
  the Chrome local-network permission probe and the printer chip, which says when the agent is
  too old to print the cached logo (`agentPrintsImages`, `IMAGE_AGENT_VERSION = 2`) or the logo
  still needs its test print.
- `printing.ts` — what prints when: `printOriginals` (with THE drawer clause), `reprint`
  (marked COPY, never the drawer), `startAutoPrint` and its catch-up, and `listRecentSales` /
  `saleStatusMark` for `/pos/sales`; the logo goes only to an agent reporting version 2
  (`logoForAgent`), and onto a receipt only after the owner confirmed the logo's test print
  (`receiptLogoConfirmed`); a receipt refused because of its image is sent once more without it.

Spec 4, 5, 6, 11. Invariants 5, 12.
