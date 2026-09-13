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
