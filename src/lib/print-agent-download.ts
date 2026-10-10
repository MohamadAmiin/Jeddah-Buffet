// THE WORDS BESIDE THE PRINT AGENT DOWNLOADS (tasks/print-agent-installer T-13,
// T-15). The dashboard's /device page and the till's /pos/printer page both offer
// the installers; this module holds their labels and first-run steps once, so the
// two screens cannot tell the owner different things.
//
// ISOMORPHIC: the server-rendered dashboard and the client-only till both import
// it, so it imports NOTHING — no sibling, no $lib, no Node builtin
// (print-agent-download.test.ts enforces it; eslint.config.js lists it beside
// src/lib/menu-images.ts).
//
// The installers are unsigned for now (a decision of 2026-10-10), so the first run
// on Windows and macOS asks the owner to confirm it; these sentences say how.

export type AgentOs = 'windows' | 'linux' | 'macos';
export type AgentArch = 'x64' | 'arm64';

/** The PC an installer is for, in the owner's words. */
export function osLabel(os: AgentOs, arch: AgentArch): string {
	if (os === 'windows') return 'Windows 10 or 11 (64-bit)';
	if (os === 'linux') return 'Linux (64-bit)';
	return arch === 'arm64' ? 'Mac with Apple silicon (M1 or later)' : 'Mac with Intel';
}

/** What to do the first time the file runs on that PC. */
export function firstRunSteps(os: AgentOs): string[] {
	const then =
		'The agent starts when this PC signs in. Then, on the till, sign in as the owner → Printer → Pair this till.';
	if (os === 'windows') {
		return ['If Windows says it protected your PC, choose More info → Run anyway.', then];
	}
	if (os === 'macos') {
		return [
			'Double-click the zip, then double-click matcami-print-agent. If the Mac blocks it, open System Settings → Privacy & Security and choose Open Anyway.',
			then
		];
	}
	return [
		'Unzip it, then run matcami-print-agent (or right-click → Properties → allow executing, then double-click).',
		then
	];
}

/** A download's size in whole megabytes (bytes, not money). */
export function sizeLabel(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1_048_576))} MB`;
}
