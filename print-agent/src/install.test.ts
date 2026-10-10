import { describe, expect, it } from 'vitest';
import { createConfig, type AgentConfig } from './config.ts';
import {
	closingLine,
	installedExePath,
	planInstall,
	type InstallInput,
	type Step
} from './install.ts';
import type { BuildInfo } from './paths.ts';

const BAKED: BuildInfo = {
	origin: 'https://pos.example.com',
	agentVersion: 2,
	builtAt: '2026-10-10T08:00:00.000Z',
	sourceSha: 'a'.repeat(64)
};
const installed = (over: Partial<AgentConfig> = {}): AgentConfig => ({
	...createConfig({
		origin: BAKED.origin,
		dataDir: '/home/till/.local/share/matcami/print-agent/data'
	}),
	...over
});
const plan = (over: Partial<InstallInput>) =>
	planInstall({
		platform: 'linux',
		isRoot: false,
		baked: BAKED,
		config: 'missing',
		agentAnswering: false,
		exeIsInstalled: false,
		...over
	});
const kinds = (steps: Step[]) => steps.map((s) => s.kind);

describe('planInstall — what running the downloaded file does', () => {
	it('refuses root, a source run and a corrupt config — and plans no write at all', () => {
		for (const steps of [
			plan({ isRoot: true }),
			plan({ baked: null }),
			plan({ config: 'corrupt' })
		]) {
			expect(kinds(steps)).toEqual(['refuse']);
		}
		expect(plan({ isRoot: true })[0]).toMatchObject({
			message: expect.stringMatching(/without sudo/)
		});
		expect(plan({ baked: null })[0]).toMatchObject({
			message: 'install is for the downloaded file. From source use init and run.'
		});
		expect(plan({ config: 'corrupt' })[0]).toMatchObject({
			message: expect.stringMatching(
				/cannot be read\. Delete it and run this again\. Every till must pair again\./
			)
		});
	});

	it('a first install: new settings, pairing open, copied, started at sign-in, setup page opened', () => {
		expect(kinds(plan({ config: 'missing' }))).toEqual([
			'create-config',
			'open-pairing',
			'copy-exe',
			'register-autostart',
			'wait-ready',
			'open-setup'
		]);
	});

	it('an update (same origin, agent running): stops it first and KEEPS the settings and the pairing', () => {
		const steps = kinds(plan({ config: installed(), agentAnswering: true }));
		expect(steps).toEqual([
			'stop-agent',
			'copy-exe',
			'register-autostart',
			'wait-ready',
			'open-setup'
		]);
		expect(steps).not.toContain('create-config');
		expect(steps).not.toContain('open-pairing');
	});

	it('a download from another address: takes the baked origin and opens pairing for it', () => {
		const steps = plan({ config: installed({ origin: 'https://old.example.com' }) });
		expect(steps[0]).toEqual({
			kind: 'update-origin',
			from: 'https://old.example.com',
			to: 'https://pos.example.com'
		});
		expect(kinds(steps)).toContain('open-pairing');
	});

	it('a config from before the installer (no setup key) gains one', () => {
		expect(kinds(plan({ config: installed({ setupSecret: null }) }))).toContain('add-setup-secret');
	});

	it('run from the installed copy: nothing to copy', () => {
		expect(kinds(plan({ config: installed(), exeIsInstalled: true }))).not.toContain('copy-exe');
	});

	// Found running the real Linux installer twice (T-18): an update said
	// "Pair this till" although the till stayed paired.
	it('asks for "Pair this till" only when the run opened pairing', () => {
		const pair = 'Next: on the till, sign in as the owner → Printer → Pair this till.';
		expect(closingLine(plan({ config: 'missing' }))).toBe(pair);
		expect(closingLine(plan({ config: installed({ origin: 'https://old.example.com' }) }))).toBe(
			pair
		);
		expect(closingLine(plan({ config: installed(), agentAnswering: true }))).toBe(
			'The till stays paired: nothing to do there.'
		);
	});
});

describe('installedExePath', () => {
	it('is an .exe on Windows and a bare binary elsewhere, inside bin/', () => {
		expect(installedExePath('win32')).toMatch(/[\\/]bin[\\/]matcami-print-agent\.exe$/);
		expect(installedExePath('linux')).toMatch(/[\\/]bin[\\/]matcami-print-agent$/);
	});
});
