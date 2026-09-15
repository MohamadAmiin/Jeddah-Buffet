// The POS service-worker registration policy, as configuration (CLAUDE.md,
// "Decisions already made"). SvelteKit auto-registers src/service-worker.ts at
// scope '/' unless told not to, and a worker at '/' controls /dashboard as well
// as the till — authenticated dashboard HTML and __data.json would then sit in
// Cache Storage, which /logout does not clear. The worker is registered by hand,
// from the POS layout only, with { scope: '/pos' } instead.
//
// This file asserts ONLY that configuration half. The scope and cache-policy
// assertions — the '/pos' scope with no trailing slash, the single precached
// shell, no runtime cache.put, no route outside (pos) whose path begins with
// 'pos' — arrive with the worker itself (T-45) and must not be stubbed here: an
// assertion over a worker that does not exist yet passes for the wrong reason.

import { describe, it, expect } from 'vitest';
import svelteConfig from '../../../svelte.config.js';

describe('service-worker registration policy', () => {
	it('does not auto-register a service worker — the default scope is / and would control the dashboard', () => {
		expect(svelteConfig.kit?.serviceWorker?.register).toBe(false);
	});
});
