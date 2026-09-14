// Stands in for $env/dynamic/private under Vitest, which runs outside SvelteKit
// and cannot resolve that virtual module.
//
// It exposes process.env unchanged, so src/lib/server/env.ts behaves exactly as
// it does in production — including its required() failures and its crypto.argon2
// assertion. vitest.config.ts aliases the integration project to this file.
export const env: Record<string, string | undefined> = process.env;
