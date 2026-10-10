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

// ── The till's Printer page (T-15) ──────────────────────────────────────────

/** One installer as GET /downloads/print-agent lists it (src/lib/server/print-agent-downloads.ts). */
export type DownloadFile = {
	name: string;
	os: AgentOs;
	arch: AgentArch;
	bytes: number;
	sha256: string;
	verified: boolean;
	url: string;
};

/** The short label of the till's download keys: "Download for Mac (Apple silicon)". */
export function shortOsLabel(os: AgentOs, arch: AgentArch): string {
	if (os === 'windows') return 'Windows';
	if (os === 'linux') return 'Linux';
	return arch === 'arm64' ? 'Mac (Apple silicon)' : 'Mac (Intel)';
}

/**
 * One entry of the manifest answer, checked before the till renders a link from
 * it — the page is client-side and must not trust a body it fetched.
 */
export function isDownloadFile(value: unknown): value is DownloadFile {
	if (typeof value !== 'object' || value === null) return false;
	const f = value as Record<string, unknown>;
	return (
		typeof f.name === 'string' &&
		(f.os === 'windows' || f.os === 'linux' || f.os === 'macos') &&
		(f.arch === 'x64' || f.arch === 'arm64') &&
		typeof f.bytes === 'number' &&
		typeof f.sha256 === 'string' &&
		/^[0-9a-f]{64}$/.test(f.sha256) &&
		typeof f.verified === 'boolean' &&
		typeof f.url === 'string' &&
		f.url === `/downloads/print-agent/${f.name}`
	);
}

/**
 * Which PC this browser runs on, from what it reports. A browser cannot tell
 * Apple silicon from an Intel Mac, and an Android phone or a Chromebook runs no
 * installer — those are 'unknown' and the page lists every file.
 */
export function guessPlatform(nav: {
	userAgent?: string;
	platform?: string;
	userAgentData?: { platform?: string };
}): AgentOs | 'unknown' {
	const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
	if (/android|cros/i.test(hint)) return 'unknown';
	if (/windows|win32|win64/i.test(hint)) return 'windows';
	if (/mac/i.test(hint)) return 'macos';
	if (/linux|x11/i.test(hint)) return 'linux';
	return 'unknown';
}

/**
 * The files for this PC first: the Windows .exe; BOTH Mac zips, Apple silicon
 * first (the browser cannot tell them apart); the Linux zip. An unknown PC gets
 * every file under `others`.
 */
export function recommend<T extends { os: AgentOs; arch: AgentArch }>(
	files: readonly T[],
	platform: AgentOs | 'unknown'
): { primary: T[]; others: T[] } {
	if (platform === 'unknown') return { primary: [], others: [...files] };
	const primary = files
		.filter((file) => file.os === platform)
		.sort((a, b) => Number(b.arch === 'arm64') - Number(a.arch === 'arm64'));
	return { primary, others: files.filter((file) => !primary.includes(file)) };
}
