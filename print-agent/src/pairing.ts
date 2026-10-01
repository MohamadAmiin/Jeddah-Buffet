// OPEN PAIRING — how a till gets the pairing secret without anyone copying it.
//
// `init` and `pair` OPEN pairing; while it is open the agent's POST /pair hands
// the secret to the FIRST caller that passes the Host and Origin walls, and that
// claim closes it. There is NO time limit (decided 2026-10-01: a ten-minute
// window closed on the owner before they reached the till). Closed, /pair
// answers 403 and says why, so the Printer screen can tell "nobody opened it"
// from "something else already took it" — the second is the owner's cue to
// re-key with `init --force`.
//
// The state is a small file in the data directory, because `pair` is a separate
// process from the running agent: the command writes it, the agent reads it at
// request time. It holds two timestamps and no secret.
//
// THE TRADE, stated once: while pairing is open, any program on this PC that
// forges the Origin header can claim the secret before the till does, and
// pairing that is opened and never used stays open. It is single-use, and a
// stolen claim is visible (the till's own Pair is refused with `claimed`).
// `link` pairs without opening anything.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PairingClaim = 'ok' | 'claimed' | 'not_open';

type PairingState = { openedAt: number; claimedAt: number | null };

const fileOf = (dataDir: string) => join(dataDir, 'pairing.json');

function read(dataDir: string): PairingState | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(fileOf(dataDir), 'utf8'));
		if (typeof raw !== 'object' || raw === null) return null;
		const { openedAt, claimedAt } = raw as Record<string, unknown>;
		if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return null;
		if (claimedAt !== null && typeof claimedAt !== 'number') return null;
		return { openedAt, claimedAt };
	} catch {
		// No file, or one that cannot be read: pairing was never opened.
		return null;
	}
}

function write(dataDir: string, state: PairingState): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(fileOf(dataDir), JSON.stringify(state) + '\n', { mode: 0o600 });
}

/** Open (or re-open) pairing: the next till to ask is paired. */
export function openPairing(dataDir: string, now = Date.now()): void {
	write(dataDir, { openedAt: now, claimedAt: null });
}

/** Take the one claim open pairing allows. The claim is on disk BEFORE `ok` is returned. */
export function claimPairing(dataDir: string, now = Date.now()): PairingClaim {
	const state = read(dataDir);
	if (!state) return 'not_open';
	if (state.claimedAt !== null) return 'claimed';
	write(dataDir, { openedAt: state.openedAt, claimedAt: now });
	return 'ok';
}
