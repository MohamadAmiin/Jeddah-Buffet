import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env.ts validates at MODULE LOAD, so each case needs a fresh import with the
// environment set the way that case needs. vi.resetModules() gives that.
//
// It lives in the integration project because it imports $env/dynamic/private,
// which only the integration project aliases.
const ORIGINAL = { ...process.env };

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	process.env = { ...ORIGINAL };
});

async function loadEnv() {
	return import('./env');
}

describe('env.ts production assertions', () => {
	it('refuses to start in production with ORIGIN unset, naming the variable', async () => {
		process.env.NODE_ENV = 'production';
		delete process.env.ORIGIN;

		await expect(loadEnv()).rejects.toThrow(/ORIGIN is not set/);
		await expect(loadEnv()).rejects.toThrow(/ORIGIN/);
	});

	it('refuses a plain-HTTP ORIGIN in production, explaining the cookie', async () => {
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'http://pos.example.com';

		await expect(loadEnv()).rejects.toThrow(/must be https:/);
	});

	it('allows http://localhost in production, but warns', async () => {
		// The one exemption, and not a loophole: SvelteKit omits the Secure flag for
		// exactly that origin, which is what makes `pnpm preview` and the Playwright
		// journey — both production builds — able to hold a session at all.
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'http://localhost:4173';

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const mod = await loadEnv();
		expect(mod.ORIGIN).toBe('http://localhost:4173');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('WRONG for a real deployment'));
		warn.mockRestore();
	});

	it('refuses plain HTTP on a NON-loopback host in production', async () => {
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'http://192.168.1.10:3000';

		await expect(loadEnv()).rejects.toThrow(/must be https:/);
	});

	it('accepts a proper https ORIGIN in production', async () => {
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'https://pos.example.com';
		process.env.ADDRESS_HEADER = 'x-forwarded-for';

		const mod = await loadEnv();
		expect(mod.ORIGIN).toBe('https://pos.example.com');
	});

	// Public sign-up's per-address cap and throttle are only as good as the address.
	// Behind a proxy with ADDRESS_HEADER unset, every visitor is 127.0.0.1: one bot's
	// three sign-ups would close sign-up for the whole internet for a day.
	it('refuses to start in production without ADDRESS_HEADER, naming it', async () => {
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'https://pos.example.com';
		delete process.env.ADDRESS_HEADER;

		await expect(loadEnv()).rejects.toThrow(/ADDRESS_HEADER/);
	});

	it('only warns about ADDRESS_HEADER on a loopback ORIGIN (pnpm preview, the e2e journey)', async () => {
		process.env.NODE_ENV = 'production';
		process.env.ORIGIN = 'http://localhost:4173';
		delete process.env.ADDRESS_HEADER;

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await loadEnv();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ADDRESS_HEADER'));
		warn.mockRestore();
	});

	it('does not impose the production rules in development', async () => {
		process.env.NODE_ENV = 'development';
		delete process.env.ORIGIN;

		const mod = await loadEnv();
		expect(mod.ORIGIN).toBeNull();
	});

	it('still refuses to start with DATABASE_URL missing, in any environment', async () => {
		process.env.NODE_ENV = 'development';
		delete process.env.DATABASE_URL;

		await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
	});
});

describe('SIGNUP, the operator switch for public sign-up', () => {
	it('is open when unset', async () => {
		process.env.NODE_ENV = 'development';
		delete process.env.SIGNUP;

		expect((await loadEnv()).SIGNUP_OPEN).toBe(true);
	});

	it('stays open with SIGNUP=open', async () => {
		process.env.NODE_ENV = 'development';
		process.env.SIGNUP = 'open';

		expect((await loadEnv()).SIGNUP_OPEN).toBe(true);
	});

	it('closes with SIGNUP=closed, in any letter case and with stray spaces', async () => {
		process.env.NODE_ENV = 'development';
		process.env.SIGNUP = ' Closed ';

		expect((await loadEnv()).SIGNUP_OPEN).toBe(false);
	});

	it('refuses to start on any other value, naming the variable', async () => {
		process.env.NODE_ENV = 'development';
		process.env.SIGNUP = 'off';

		await expect(loadEnv()).rejects.toThrow(/SIGNUP/);
	});
});
