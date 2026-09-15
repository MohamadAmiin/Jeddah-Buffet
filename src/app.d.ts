// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The dashboard principal, or null. Populated by src/hooks.server.ts.
			 *
			 * This is the `Principal` type from auth/session — deliberately NOT a
			 * redeclared shape, which could drift from it and quietly widen what the
			 * layout serialises into the page.
			 */
			user: import('$lib/server/auth/session').Principal | null;
			/**
			 * Set for `(dashboard)` routes ONLY, and null everywhere else.
			 *
			 * That restriction looks odd and is deliberate: a future POS or sync route
			 * must resolve its tenant from the REGISTERED DEVICE row and its actor from
			 * the queued operation, never from whichever owner last logged in on that
			 * browser. Leaving this null outside the dashboard means such a route fails
			 * loudly the first time somebody wires it to locals by habit, instead of
			 * silently posting one restaurant's sales under another restaurant's id.
			 *
			 * Its POS counterpart is `posDevice` below: resolved from the registered
			 * device cookie by requireDevice(), and never from this field.
			 */
			restaurantId: string | null;
			/**
			 * The registered POS device for this request, or null. Set by requireDevice()
			 * in $lib/server/auth/pos-context — NEVER by the hook, and never inferred from
			 * a session cookie. A route that needs a tenant outside /(dashboard) reads it
			 * from here after calling requireDevice, not from restaurantId above.
			 */
			posDevice: import('$lib/server/auth/pos-context').PosDeviceContext | null;
			/** The raw cookie token, so the hook can re-set a slid cookie. */
			sessionToken: string | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
