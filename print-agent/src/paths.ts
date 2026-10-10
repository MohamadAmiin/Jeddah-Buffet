// WHERE THE AGENT LIVES, AND WHICH BUILD IT IS (tasks/print-agent-installer T-01).
//
// The agent runs two ways. From SOURCE — `node print-agent/src/main.ts`, the
// way development, the vitest `print-agent` project and the e2e harness run it —
// its config and data sit beside src/, exactly as before. PACKAGED — the one-file
// installer a restaurant downloads, a Node 24 single executable application with
// this code bundled into it — they sit in a per-user folder, because the binary
// can be anywhere (Downloads, then its own install folder) and needs no
// administrator rights to write there.
//
// A packaged build also carries `build.json`, a SEA asset written by
// scripts/build-print-agent.ts: the app origin this installer answers, baked in
// at BUILD time on the server that serves the download. The origin is never
// adopted from a request (decision 1 of the plan): an agent that trusted the
// first page to pair would hand the cash drawer to any page open on the PC.
//
// THIS IS THE ONLY FILE THAT TOUCHES import.meta (besides main.ts's entry
// guard). The installer bundle is CommonJS, where esbuild replaces import.meta
// with {}; scripts/build-print-agent.ts defines import.meta.dirname, .filename
// and .main away and fails on any other use, so a stray import.meta elsewhere
// cannot silently become undefined inside the binary.
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { parseOrigin } from './config.ts';

/** True inside the one-file installer; false under `node print-agent/src/main.ts` and vitest. */
export function isPackaged(): boolean {
	return isSea();
}

/** What scripts/build-print-agent.ts bakes into every installer. */
export type BuildInfo = { origin: string; agentVersion: 2; builtAt: string; sourceSha: string };

/**
 * The installer's baked build info, or null when running from source. Throws when
 * a packaged build carries a build.json it cannot trust — a binary that does not
 * know which origin to answer must not start.
 */
export function bakedBuild(): BuildInfo | null {
	// getAsset throws outside a single executable application.
	if (!isPackaged()) return null;
	const invalid = () => new Error('build: build.json is invalid — rebuild the installer');
	let raw: unknown;
	try {
		raw = JSON.parse(getAsset('build.json', 'utf8'));
	} catch {
		throw invalid();
	}
	if (typeof raw !== 'object' || raw === null) throw invalid();
	const { origin, agentVersion, builtAt, sourceSha } = raw as Record<string, unknown>;
	if (agentVersion !== 2 || typeof builtAt !== 'string' || typeof sourceSha !== 'string') {
		throw invalid();
	}
	let parsed: string;
	try {
		parsed = parseOrigin(origin);
	} catch {
		throw invalid();
	}
	return { origin: parsed, agentVersion, builtAt, sourceSha };
}

/**
 * The per-user folder a packaged agent installs into: its binary (bin/), its
 * config.json and its data/ (the job queue, the seen ids, the log). Every OS's
 * own place for per-user application data, so no administrator rights.
 */
export function installDir(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
	home: string = homedir()
): string {
	if (platform === 'win32') {
		// path.win32, so a test on Linux builds the path the Windows agent would.
		const base = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
		return win32.join(base, 'matcami', 'print-agent');
	}
	if (platform === 'darwin') {
		return join(home, 'Library', 'Application Support', 'matcami', 'print-agent');
	}
	return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'matcami', 'print-agent');
}

/**
 * Where config.json and data/ are by default. Computed when asked, never at
 * module load: in the CommonJS bundle import.meta.dirname is defined away, and
 * the packaged branch must never read it.
 */
export function defaultPaths(): { configPath: string; dataDir: string } {
	if (isPackaged()) {
		const dir = installDir();
		return { configPath: join(dir, 'config.json'), dataDir: join(dir, 'data') };
	}
	return {
		configPath: resolve(import.meta.dirname, '..', 'config.json'),
		dataDir: resolve(import.meta.dirname, '..', 'data')
	};
}

/**
 * How to start this same agent again with other arguments — the Windows logon
 * task's console-less relaunch (autostart.ts) uses it. Packaged, the binary is the
 * program; from source, it is node plus this file.
 */
export function selfCommand(args: string[]): { command: string; args: string[] } {
	if (isPackaged()) return { command: process.execPath, args };
	return {
		command: process.execPath,
		args: [...process.execArgv, resolve(import.meta.dirname, 'main.ts'), ...args]
	};
}
