// The login page's ONE bit of disclosure, driven through the REAL load: whether
// public sign-up is open. It follows the SIGNUP switch and NOTHING else — in
// particular not how many companies exist, which it did while /register was
// first-run only.

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { testDb, closeTestDb } from '$lib/server/db/test/db';
import { restaurants } from '$lib/server/db/schema/restaurants';

const db = testDb();
const ORIGINAL_SIGNUP = process.env.SIGNUP;

afterEach(() => {
	if (ORIGINAL_SIGNUP === undefined) delete process.env.SIGNUP;
	else process.env.SIGNUP = ORIGINAL_SIGNUP;
});

afterAll(async () => {
	await closeTestDb();
});

/** env.ts reads SIGNUP at import, so each call imports the route afresh. */
async function signedOutLoad() {
	vi.resetModules();
	const { load } = await import('./+page.server');
	return (load as (e: unknown) => unknown)({ locals: { user: null } });
}

describe('/login load', () => {
	// toEqual, not toMatchObject: that one bit and NOTHING else — no restaurant
	// name, no user list.
	it('offers sign-up while it is open, however many companies exist', async () => {
		delete process.env.SIGNUP;
		expect(await signedOutLoad()).toEqual({ signupOpen: true });

		await db.insert(restaurants).values({ name: 'Cafe One' });

		expect(await signedOutLoad()).toEqual({ signupOpen: true });
	});

	it('stops offering it when the operator closes sign-up', async () => {
		process.env.SIGNUP = 'closed';
		expect(await signedOutLoad()).toEqual({ signupOpen: false });
	});
});
