import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimPairing, openPairing, pairingState } from './pairing.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), 'matcami-agent-pairing-'));
	dirs.push(dir);
	return dir;
};

const T0 = 1_800_000_000_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('open pairing', () => {
	it('is closed until someone opens it', () => {
		expect(claimPairing(tmp(), T0)).toBe('not_open');
	});

	it('gives exactly ONE claim, then says claimed — even to a second process reading the file', () => {
		const dir = tmp();
		openPairing(dir, T0);
		expect(claimPairing(dir, T0 + 1)).toBe('ok');
		expect(claimPairing(dir, T0 + 2)).toBe('claimed');
		expect(claimPairing(dir, T0 + YEAR_MS)).toBe('claimed');
	});

	it('has no time limit: it stays open until a till pairs', () => {
		const dir = tmp();
		openPairing(dir, T0);
		expect(claimPairing(dir, T0 + YEAR_MS)).toBe('ok');
	});

	it('opening again gives a fresh claim', () => {
		const dir = tmp();
		openPairing(dir, T0);
		expect(claimPairing(dir, T0)).toBe('ok');
		openPairing(dir, T0 + 5);
		expect(claimPairing(dir, T0 + 6)).toBe('ok');
	});

	it('creates the data directory, writes mode 0600, and holds no secret', () => {
		const dir = join(tmp(), 'data');
		openPairing(dir, T0);
		const file = join(dir, 'pairing.json');
		expect(existsSync(file)).toBe(true);
		if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openedAt: T0, claimedAt: null });
		expect(claimPairing(dir, T0 + 9)).toBe('ok');
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ openedAt: T0, claimedAt: T0 + 9 });
	});

	it('pairingState reads where pairing stands without changing it', () => {
		const dir = tmp();
		expect(pairingState(dir)).toBe('not_open');
		openPairing(dir, T0);
		expect(pairingState(dir)).toBe('open');
		expect(pairingState(dir)).toBe('open');
		expect(claimPairing(dir, T0 + 1)).toBe('ok');
		expect(pairingState(dir)).toBe('claimed');
	});

	it('a damaged state file is closed pairing, never open pairing', () => {
		const dir = tmp();
		for (const text of [
			'',
			'not json',
			'[]',
			'{"openedAt":"now","claimedAt":null}',
			'{"openedAt":1}',
			'{"until":1800000600000,"claimedAt":null}'
		]) {
			writeFileSync(join(dir, 'pairing.json'), text);
			expect(claimPairing(dir, 0), text).toBe('not_open');
		}
	});
});
