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
import { env } from '$env/dynamic/private';

function required(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

export const DATABASE_URL = required('DATABASE_URL');
