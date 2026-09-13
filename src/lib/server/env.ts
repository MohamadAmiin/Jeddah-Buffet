// Reads and validates the environment ONCE, at startup, so a missing variable
// fails loudly here rather than surfacing as `undefined` deep inside a query.
//
// This file lives under src/lib/server/ deliberately: SvelteKit build-blocks
// $lib/server/** from client code, and that block is the mechanism that stops a
// credential reaching the browser (invariant 12). Never move environment
// reading into a shared or client-importable module.
//
// $env/dynamic/private, not $env/static/private: adapter-node reads the
// environment at runtime, so a static import would bake build-time values into
// the production bundle.
import { argon2 } from 'node:crypto';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

// Fail at BOOT, not at the owner's first login. crypto.argon2 first shipped in
// Node v24.7.0, and package.json's engines floor is >=24.21.0 to match — but
// engines is advisory once node_modules exists, so assert the runtime directly.
// Without this the failure surfaces as `TypeError: crypto.argon2 is not a
// function` during registration, long after install, build and every non-hashing
// test have passed.
if (typeof argon2 !== 'function') {
	throw new Error(
		'This runtime has no crypto.argon2. matcami requires Node >= 24.21.0 ' +
			'(crypto.argon2 landed in v24.7.0). Run `nvm use` — .nvmrc pins the version.'
	);
}

function required(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

// The RUNTIME connection. This role owns nothing — it cannot create, drop or
// truncate a table. Application code uses only this.
export const DATABASE_URL = required('DATABASE_URL');

// The OWNER connection, used by drizzle-kit and pg_dump. Validated here so a
// missing value fails loudly at startup rather than as `undefined` inside a
// migration run.
//
// NOTE for T-26, which owns this file's production assertions: requiring it at
// application startup means the runtime environment must carry the OWNER
// credential, which works against the containment the role split exists to
// provide — an attacker with code execution in the app process would find the
// owner URL in the environment. Migrations and dumps run outside this process
// (deployment uses a separate runner), so making this optional in production is
// worth deciding deliberately there. T-02 of this plan specifies it as validated,
// and that is what ships today.
export const MIGRATE_DATABASE_URL = required('MIGRATE_DATABASE_URL');

/**
 * OPTIONAL. The one-time secret that opens /register while zero restaurants
 * exist. When it is unset, /register refuses every submission regardless of the
 * restaurant count — a freshly deployed instance must not be claimable by the
 * first stranger who finds its hostname.
 *
 * Unset it again once the owner has registered.
 */
export const SETUP_TOKEN: string | null = env.SETUP_TOKEN || null;

/**
 * adapter-node's public origin. Required in production for SvelteKit's CSRF
 * origin check to pass behind a proxy.
 */
export const ORIGIN: string | null = env.ORIGIN || null;

const IS_PRODUCTION = env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';

// `building` matters: `vite build` runs with NODE_ENV=production and SvelteKit
// evaluates server modules during the build, so without this guard a RUNTIME
// requirement fires at BUILD time — and a build machine legitimately has no
// production ORIGIN. These are checks on the environment the server will SERVE
// in, not on the one it was compiled in.
if (!building && IS_PRODUCTION) {
	// Fail at startup rather than with `403 Cross-site POST form submissions are
	// forbidden` on every login — because the tempting fix for THAT is disabling
	// the origin check, which invariant 12 forbids.
	if (!ORIGIN) {
		throw new Error(
			'ORIGIN is not set. adapter-node needs it in production for SvelteKit’s CSRF origin ' +
				'check to pass behind a proxy. Set ORIGIN to the public URL, e.g. ' +
				'https://pos.example.com. Never disable the origin check instead.'
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(ORIGIN);
	} catch {
		throw new Error(`ORIGIN is not a valid URL: set it to e.g. https://pos.example.com`);
	}

	const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';

	if (parsed.protocol !== 'https:' && !isLoopback) {
		throw new Error(
			`ORIGIN must be https: in production (got "${parsed.protocol}://${parsed.hostname}"). The ` +
				'session cookie is Secure for every origin except http://localhost, and a browser ' +
				'discards a Secure cookie delivered over plain HTTP — which produces a silent endless ' +
				'login loop. See docs/deployment.md.'
		);
	}

	// http://localhost is the ONE exemption, and it is not a loophole: SvelteKit
	// omits the Secure flag for exactly that origin, so the cookie survives. It is
	// what `pnpm preview` and the Playwright journey run on — both of which are
	// production builds by design. A REAL deployment on a loopback origin is still
	// wrong, so say so rather than passing silently.
	if (isLoopback) {
		console.warn(
			`[matcami] ORIGIN is ${ORIGIN}. That is correct for a local production build ` +
				'(pnpm preview, the e2e journey) and WRONG for a real deployment: serve over HTTPS on ' +
				'the public hostname. See docs/deployment.md.'
		);
	}

	if (!env.ADDRESS_HEADER) {
		// A warning, not a throw: the app works, but the audit trail degrades
		// SILENTLY, which is exactly why it is said loudly.
		console.warn(
			'[matcami] ADDRESS_HEADER is not set. Behind a proxy, getClientAddress() returns the ' +
				'proxy’s address — so every audit row records 127.0.0.1 and the login throttle treats ' +
				'all visitors as one client. Set ADDRESS_HEADER=x-forwarded-for and XFF_DEPTH=1, and ' +
				'add `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` in Nginx.'
		);
	}
}

// An operator should never have to guess whether the registration window is open.
// Stated without a database query, because this module is read at import time and
// must not do I/O: the restaurant-count half of the condition is reported by
// /register's own load, which already knows it.
if (SETUP_TOKEN) {
	console.info(
		'[matcami] SETUP_TOKEN is set: /register will accept a first restaurant while none exists. Unset it after the owner has registered.'
	);
} else {
	console.info(
		'[matcami] SETUP_TOKEN is not set: /register will refuse every submission. Set it to register the first restaurant.'
	);
}
