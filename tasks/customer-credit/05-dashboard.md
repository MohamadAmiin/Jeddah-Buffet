# Phase 5 — Dashboard

**Depends on:** Phase 3. Pattern to copy: `src/routes/(dashboard)/purchases/` (`+page.server.ts`, `new/`, `[id]/`, `helpers.ts`). Every `load` and every action calls `requirePermission` FIRST and takes `restaurantId` from the session, never from the form (invariant 8). zod stays server-side. Screens compose `src/lib/components/ui/` primitives; no colour, size or type literal; money through the money module's formatter, mono, tabular, right-aligned.

### T-21 — `/customers`, `/customers/new`, `/customers/[id]`

**Needs:** T-08, T-11
**Files:**
- `src/routes/(dashboard)/customers/+page.server.ts`, `+page.svelte` — NEW
- `src/routes/(dashboard)/customers/new/+page.server.ts`, `+page.svelte` — NEW
- `src/routes/(dashboard)/customers/[id]/+page.server.ts`, `+page.svelte` — NEW
- `src/routes/(dashboard)/customers/helpers.ts` — NEW (zod schemas, messages)
- `src/lib/components/ui/Sidebar.svelte` — EDIT (`'/customers'` in the `href` union; a "Customers" item in the money group; a new icon needs its `IconName` entry AND its drawn branch); `sidebar.test.ts` — EDIT
- integration tests beside each route — NEW (model: `purchases-page.integration.test.ts`)
**Invariants:** 8, 2

**Do:**
1. Permission `admin.customers` on everything.
2. `/customers`: table of name, phone, limit, balance, status (`● active` / `◐ archived`); a "Total owed" tile; the 1100 tripwire warning from `receivableTripwire` when the sum of balances differs from the ledger; a filter to show archived.
3. `/customers/new`: name, phone, optional limit (typed amount parsed with `parsePriceInput`, never a float). `phone_taken` shown on the field.
4. `/customers/[id]`: edit form; **Archive** (refusals `has_balance`, `has_unrecorded_charge` in words) / **Restore**; the statement — date, what (invoice number or "Payment — <method>" or "Reversal — <reason>"), cashier, till, amount, running balance; on each unreversed payment a **Reverse** control in a native `<details>` with a reason (3–200). The action checks the payment belongs to THIS customer before calling `reverseCustomerPayment`; `shift_closed` is explained: "This cash payment's shift is closed, so it can no longer be reversed."
5. No action here creates a charge or receives a payment — those happen only on the till.

**Tests — MANDATORY (permission per route):** every load and every action answers 403 for a non-owner and for a direct POST without the key; another restaurant's customer id → 404; create/edit/archive/restore/reverse happy paths write their audit rows; `route-guards.test.ts` passes.

**Done when:** `pnpm test -- customers route-guards sidebar` passes.

---

### T-22 — The Customer credit switch

**Needs:** T-09
**Files:**
- `src/routes/(dashboard)/settings/payments/+page.server.ts`, `+page.svelte` — EDIT; its integration test — EDIT
**Invariants:** 8

**Do:**
1. A separate card "Customer credit" with one switch and the sentence: "Lets every employee who can take payment charge a bill to a registered customer. Turning it off stops new charges; customers can still pay what they owe."
2. Action `setCredit` → `requirePermission(event, 'admin.settings')` → `setCreditEnabled`. The credit row never appears among the editable methods.

**Tests:** 403 without the key; enabling on a restaurant without the row or account 1100 creates both.

**Done when:** `pnpm test -- settings/payments` passes.

---

### T-23 — Report rows and `/reports/credit`

**Needs:** T-14
**Files:**
- `src/routes/(dashboard)/reports/+page.server.ts`, `+page.svelte` — EDIT (labels keyed by kind gain `credit`; the takings caption; two new sections)
- `src/routes/(dashboard)/reports/credit/+page.server.ts`, `+page.svelte` — NEW (model: `reports/tax-overrides/`); its integration test — NEW
**Invariants:** 8, 11

**Do:**
1. `/reports`: the caption becomes "Takings: money received for today's sales. Net sales + tax = takings + sold on credit." A "Sold on credit (not received)" figure; a "Customer payments received" section by method; "By tender" and "By payment method" show the credit row labelled "Customer credit (not received)". Keep the plain `<section><h3><table>` markup these sections use (e2e reads row text).
2. `/reports/credit` (`admin.reports`): for the chosen business date, the credit charges and the customer payments/reversals, each with a total per cashier; a link from `/reports`.

**Tests — MANDATORY:** 403 without `admin.reports`; the page shows the day's charge and payment from seeded data.

**Done when:** `pnpm test -- reports` passes.
