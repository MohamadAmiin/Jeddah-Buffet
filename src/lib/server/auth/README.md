# `auth/` — cookie sessions, PIN hash + lockout, POS device registration

Cookie sessions, PIN hash + lockout, POS device registration.

- PINs are 4–6 digits stored ONLY as slow salted hashes (Argon2/bcrypt). Never
  reversible, never logged, never compared in plaintext.
- 5 wrong attempts lock the employee out for 5 minutes and write an audit
  event. The POS returns to employee-select after idle (default 2 min,
  configurable).
- The PIN screen is shown ONLY on a device the owner registered — a long-lived
  HttpOnly + Secure device cookie, revocable from the dashboard.
- Sessions are HttpOnly + Secure + SameSite cookies. **Never `localStorage`.**
  SvelteKit's origin/CSRF check stays ON (invariant 12).
- An auth session is not a POS session; a POS session is a cashier shift.

**Must never be imported by** client-side code or `src/lib/pos/`.

Spec 7, 9, 12. Invariant 12.
