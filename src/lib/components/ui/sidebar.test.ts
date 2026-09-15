// The rail's SOURCE TEXT, read raw. Not a render test, on purpose: the unit
// project runs in node with no Svelte compiler and no SvelteKit aliases, so a
// .svelte import cannot compile and $app/paths cannot resolve. tokens.test.ts and
// components.test.ts are the precedents; pnpm test:e2e exercises the rendering.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./Sidebar.svelte', import.meta.url)), 'utf8');

describe('the dashboard rail', () => {
	// The label and the URL differ on purpose: "POS" is the row the owner looks
	// for, and /device is the dashboard page that registers, revokes and launches
	// the till — /pos is the till itself.
	it('has a POS row pointing at the dashboard page, not at the till', () => {
		expect(source).toMatch(/label:\s*'POS',\s*href:\s*'\/device',\s*icon:\s*'pos'/);
	});

	it('has no Devices row left', () => {
		expect(source).not.toContain("'Devices'");
		expect(source).not.toContain("'devices'");
	});

	// No closing quote in the pattern, deliberately: it fails on '/pos' (the till)
	// AND on '/pos-device' or any other URL sharing the prefix. The till's service
	// worker is scoped to /pos by STRING prefix, so it would control such a page.
	it('has no rail href beginning with /pos', () => {
		expect(source).not.toMatch(/href:\s*'\/pos/);
	});

	// A stale union member or a missing branch renders an EMPTY <svg> with no error
	// anywhere — a row with a blank square.
	it('draws every icon it names, and names every icon it draws', () => {
		const union = source.slice(source.indexOf('type IconName'), source.indexOf('type NavItem'));
		const members = [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
		expect(members).toContain('pos');
		expect(members).not.toContain('devices');
		for (const member of members) {
			expect(source.includes(`name === '${member}'`), `no branch draws '${member}'`).toBe(true);
		}
		const branches = [...source.matchAll(/name === '([a-z-]+)'/g)].map((match) => match[1]);
		for (const branch of branches) expect(members).toContain(branch);
	});

	// Every task that turns a rail row on must decrement this number in the same
	// commit. T-31 turns `Employees` on (6 → 5) and T-39 turns `Menu` on (5 → 4).
	it('counts the rows that are not built yet', () => {
		expect(source.match(/href: null/g)?.length).toBe(5);
	});

	it('has a live Employees row', () => {
		expect(source).toMatch(/label:\s*'Employees',\s*href:\s*'\/employees'/);
	});
});
