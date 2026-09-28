# Research — POS access and Menu

Findings are **evidence, not decisions**. A source never silently overrides `docs/spec.md`. Every
`CONFLICT WITH SPEC` and every `GAP` below also appears in `00-overview.md`'s risk or assumptions
section.

---

## Q: What hash can verify a 4-6 digit PIN **in the browser**, offline, for spec 6's cached hashes?

This is the question `src/lib/server/db/schema/users.ts` refuses to answer in a migration. Its
comment reads: *"The POS plan must therefore choose an algorithm available in WebCrypto or WASM,
which may not be the server-side argon2id parameters T-10 uses for passwords."*

- **Source:** https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html —
  accessed 2026-09-14
- **Says:** for PBKDF2-HMAC-SHA256, **"600,000 iterations (recommended)"**; for PBKDF2-HMAC-SHA512,
  **"220,000 iterations"**. Argon2id is recommended at `m=19456 (19 MiB), t=2, p=1` among other
  equivalent settings — which is exactly what `src/lib/server/auth/password.ts` already uses for
  passwords.
- **Source:** https://github.com/anvilresearch/webcrypto/issues/63 and
  https://asecuritysite.com/webcrypto/crypt_arg — accessed 2026-09-14
- **Says:** WebCrypto exposes **PBKDF2** as its key-derivation function; **Argon2 is not in
  WebCrypto** and running it in a browser requires a WASM build. Native Argon2id in WebCrypto is
  proposed but not shipped across Chromium, Firefox and Safari.
- **Affects the plan:** the PIN hash cannot reuse `src/lib/server/auth/password.ts`. Node 24 and
  every target browser both expose `crypto.subtle.deriveBits` with PBKDF2, so **one isomorphic
  module** (`src/lib/pin/`) can hold the single implementation used by the server and by the
  offline till — which is what spec 6 needs and what avoids two hash formats drifting apart. It adds
  **no runtime dependency** to a project whose dependencies are exactly `drizzle-orm`, `pg` and
  `zod`; a WASM Argon2 would be the first.
  T-03 must obtain the decision; T-11 implements it; T-06 stores the parameters **beside** the hash
  in a PHC-style string, exactly as `password.ts` already does, so the cost factor can be raised
  later without invalidating stored hashes.
- **Not a conflict.** Spec 7 says PINs are stored "only as slow salted hashes (e.g. Argon2 or
  bcrypt)". The **"e.g."** is the operative word: it names examples, not a closed list, and spec 6
  independently requires browser-side verification, which neither example supports. PBKDF2 at the
  OWASP work factor is a slow salted hash and satisfies the stated requirement.

### GAP — for the user. Not resolved here.

A 4-6 digit PIN has at most **10^6** possible values. Spec 6 requires those hashes to be **cached on
the registered device** so an employee can switch users while offline. Anyone who takes the tablet
therefore holds both the hashes and unlimited offline guesses, and **no choice of hash algorithm
changes that** — PBKDF2 at 600,000 iterations, Argon2id and bcrypt are all recoverable over a
keyspace that small given the device.

Two lens findings raising this were refuted on the grounds that spec 6 *mandates* the design, which
is correct and is exactly why it belongs here rather than in the risk list. The spec says nothing
about the residual risk.

The compensating controls that already exist in the design are: the PIN is useless without a
**registered device**, the owner can **revoke** that device from the dashboard (spec 7), and every
action that can move money needs an **owner PIN approval** (spec 8). The choices available if the
user wants more:

1. **Accept it** — the plan proceeds as written. This is the default it currently carries.
2. **Require 6 digits** rather than spec 7's 4-6, costing 100x the guessing work for no UX change
   worth speaking of.
3. **Expire the cached bundle** — refuse offline employee *switching* after N hours without a sync,
   while the already-signed-in employee keeps working (spec 6 guarantees only the latter).

**T-03 must put this to the user before T-06 writes the PIN columns.** Option 2 changes a validation
bound; option 3 changes what T-28 stores.

---

## Q: How is a service worker registered and scoped in SvelteKit 2.70, and can it be confined to the POS?

- **Source:** https://svelte.dev/docs/kit/service-workers — accessed 2026-09-14
- **Says:** *"SvelteKit automatically registers your service worker if you create a
  `src/service-worker.js` or `src/service-worker/index.js` file."* Registration happens on page load.
  The `$service-worker` module exports `build`, `files`, `version` and `base`. *"The service worker
  is bundled for production, but not during development"*, and the `build`/`prerendered` arrays are
  empty in dev. Automatic registration can be disabled in configuration, after which you register
  manually through `navigator.serviceWorker.register()` and control scope yourself.
- **Source:** https://github.com/sveltejs/kit/discussions/9357 and
  https://github.com/sveltejs/kit/issues/922 — accessed 2026-09-14
- **Says:** with `kit.serviceWorker.register: false`, register by hand with
  `navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' })`.
  A common pattern is to defer it to the window `load` event. In dev the `module` type is required
  because only module-capable browsers can run it.
- **Affects the plan:** the default is registration at scope **`/`**, injected into every
  server-rendered page. That is the second half of the blocker in `00-overview.md`: the POS worker
  would control `/dashboard`.
  The Service Worker specification permits a script at `/service-worker.js` to claim any scope **at
  or below its own directory**, so `{ scope: '/pos' }` is legal and narrowing; widening beyond the
  script's directory is what requires a `Service-Worker-Allowed` header, and this plan never needs
  one. Note the absence of a trailing slash — scope matching is a plain string prefix on the client
  URL, so `/pos/` would not match the landing screen `/pos` itself (T-02 decides this, T-27
  implements it, T-45 pins it with a test).
- **The prerequisite that is easy to miss:** a **route group is not a URL segment**. Today
  `src/routes/(pos)/+layout.svelte` contributes nothing to any path, so a page at
  `src/routes/(pos)/till/+page.svelte` would serve at `/till` and **there would be no `/pos` prefix
  to scope a worker to at all.** T-23 creates the real prefix by placing pages under
  `src/routes/(pos)/pos/**`. Verify this against the repo rather than trusting it: the existing
  `src/routes/(dashboard)/dashboard/+page.svelte` serves at `/dashboard` precisely because of the
  inner `dashboard/` directory, not because of the group name.

---

## Q: Does anything in the current toolchain block a same-origin installable POS?

- **Source:** the repo itself, read 2026-09-14 — `package.json`, `svelte.config.js`,
  `eslint.config.js`.
- **Says:** `@sveltejs/kit` 2.70.3, `svelte` 5.57.0, `vite` 8.3.0, `@sveltejs/adapter-node` 5.5.7.
  Runtime dependencies are exactly `drizzle-orm`, `pg`, `zod`. There is no service worker, no
  manifest, and no PWA tooling. `eslint.config.js` forbids `$lib/server/**` imports from
  `src/lib/pos/**` and `src/routes/(pos)/**/*.{ts,svelte}`.
- **Affects the plan:** no new tooling is required — a hand-written `src/service-worker.ts` and a
  static manifest are enough, and adding a PWA plugin would be scope the user did not ask for. The
  eslint boundary is the reason `/api/pos/*` exists at all: POS server work cannot be a
  `+page.server.ts` under the group, and `src/routes/route-guards.test.ts` can only see routes that
  have server files, so putting the endpoints under `src/routes/api/` is what makes spec 29's
  "a permission check test on every POS API route" mechanically checkable.

---

## Q: Is a secure context required, and does that interact with the hosting decision?

- **Source:** https://svelte.dev/docs/kit/service-workers — accessed 2026-09-14
- **Says:** service workers require HTTPS (with `localhost` exempted for development).
- **Affects the plan:** `navigator.storage.persist()`, the service worker and the `Secure` cookie
  attribute on the device cookie all require a secure context. Open decision 2 defaults to cloud
  hosting behind Nginx, where this is satisfied. `docs/deployment.md` already covers TLS.
  **No task may silently drop the `Secure` attribute to make local testing easier** — T-24 and T-27
  must work on `localhost` because it is exempted, not because the attribute was removed.
