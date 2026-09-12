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
- The browser NEVER talks to hardware. The print agent owns the printers and
  the drawer, over local WebSocket/HTTP.

Spec 4, 5, 6, 11. Invariants 5, 12.
