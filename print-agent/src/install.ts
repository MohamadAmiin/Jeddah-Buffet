// THE ONE-FILE INSTALLER'S OWN COMMANDS (tasks/print-agent-installer T-08).
//
// A restaurant owner downloads one file and runs it. With no arguments the
// packaged agent INSTALLS itself: it keeps (or creates) its settings, stops an
// older copy that is running, copies itself into the per-user folder, registers
// itself to start at sign-in, waits until it answers, and opens its setup page.
// Running the file again is how an owner updates it, and how they get back to
// the setup page (`setup`) — nobody types a command or installs anything else.
//
// What decides the steps is a PURE function, planInstall, so every path is
// tested without a process: a corrupt config is never written over (it may hold
// the only copy of the pairing token), an update keeps the pairing and every
// queued receipt, and nothing runs as root.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import {
	registerAutostart,
	stopAutostart,
	unregisterAutostart,
	type AutostartResult
} from './autostart.ts';
import {
	ConfigMissingError,
	createConfig,
	DEFAULT_AGENT_PORT,
	loadConfig,
	saveConfig,
	type AgentConfig
} from './config.ts';
import { openPairing } from './pairing.ts';
import { bakedBuild, installDir, isPackaged, type BuildInfo } from './paths.ts';

export type InstallInput = {
	platform: string;
	isRoot: boolean;
	baked: BuildInfo | null;
	config: 'missing' | 'corrupt' | AgentConfig;
	agentAnswering: boolean;
	exeIsInstalled: boolean;
};

export type Step =
	| { kind: 'refuse'; message: string }
	| { kind: 'create-config' }
	| { kind: 'update-origin'; from: string; to: string }
	| { kind: 'add-setup-secret' }
	| { kind: 'open-pairing' }
	| { kind: 'stop-agent' }
	| { kind: 'copy-exe' }
	| { kind: 'register-autostart' }
	| { kind: 'wait-ready' }
	| { kind: 'open-setup' };

/** The config file's path inside the per-user folder. */
export const installedConfigPath = () => join(installDir(), 'config.json');

/** Where the installed binary lives. */
export function installedExePath(platform: string = process.platform): string {
	return join(
		installDir(),
		'bin',
		platform === 'win32' ? 'matcami-print-agent.exe' : 'matcami-print-agent'
	);
}

/** Decide what installing means right now. Pure: no file, no process, no network. */
export function planInstall(input: InstallInput): Step[] {
	if (input.isRoot) {
		return [{ kind: 'refuse', message: 'Run this without sudo, as the user who uses the till.' }];
	}
	if (input.baked === null) {
		return [
			{
				kind: 'refuse',
				message: 'install is for the downloaded file. From source use init and run.'
			}
		];
	}
	if (input.config === 'corrupt') {
		return [
			{
				kind: 'refuse',
				message: `${installedConfigPath()} cannot be read. Delete it and run this again. Every till must pair again.`
			}
		];
	}
	const steps: Step[] = [];
	if (input.config === 'missing') {
		steps.push({ kind: 'create-config' }, { kind: 'open-pairing' });
	} else {
		if (input.config.origin !== input.baked.origin) {
			steps.push(
				{ kind: 'update-origin', from: input.config.origin, to: input.baked.origin },
				{ kind: 'open-pairing' }
			);
		}
		if (input.config.setupSecret === null) steps.push({ kind: 'add-setup-secret' });
	}
	if (input.agentAnswering) steps.push({ kind: 'stop-agent' });
	if (!input.exeIsInstalled) steps.push({ kind: 'copy-exe' });
	steps.push({ kind: 'register-autostart' }, { kind: 'wait-ready' }, { kind: 'open-setup' });
	return steps;
}

// ── Talking to a running agent ──────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Something accepts connections on 127.0.0.1:<port>. */
export function portAnswers(port: number): Promise<boolean> {
	return new Promise((done) => {
		const socket = connect({ host: '127.0.0.1', port });
		const finish = (answer: boolean) => {
			socket.destroy();
			done(answer);
		};
		socket.setTimeout(500, () => finish(false));
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

/** POST to the agent's own setup API, as its setup page would. Status 0 = no answer. */
function setupPost(
	port: number,
	path: string,
	secret: string
): Promise<{ status: number; body: unknown }> {
	return new Promise((done) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				method: 'POST',
				timeout: 2000,
				headers: {
					host: `127.0.0.1:${port}`,
					origin: `http://127.0.0.1:${port}`,
					'content-type': 'application/json',
					'x-setup-secret': secret
				}
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					let body: unknown = null;
					try {
						body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					} catch {
						body = null;
					}
					done({ status: res.statusCode ?? 0, body });
				});
			}
		);
		req.on('timeout', () => req.destroy());
		req.on('error', () => done({ status: 0, body: null }));
		req.end('{}');
	});
}

/** True once no process has this id (signal 0 only asks; EPERM means it exists under another user). */
function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as { code?: unknown }).code === 'ESRCH';
	}
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (await check()) return true;
		await sleep(250);
	}
	return false;
}

/** Stop a running agent the way that never interrupts a print mid-record. */
async function stopAgent(platform: string, config: AgentConfig | null): Promise<boolean> {
	// Through the supervisor first, so it does not start the agent again mid-update.
	if (platform !== 'win32') stopAutostart(platform);
	const port = config?.port ?? DEFAULT_AGENT_PORT;
	// Never `taskkill /F`: a forced kill between "sent" and "recorded" prints that receipt twice.
	let pid: number | null = null;
	if (config?.setupSecret && (await portAnswers(port))) {
		const answer = await setupPost(port, '/setup/quit', config.setupSecret);
		const named = (answer.body as { pid?: unknown } | null)?.pid;
		if (typeof named === 'number' && Number.isInteger(named) && named > 0) pid = named;
	}
	// The port closes before the process ends; its binary stays in use until it
	// ends, so wait for both before anything replaces that binary.
	return until(
		async () => !(await portAnswers(port)) && (pid === null || processGone(pid)),
		10_000
	);
}

/**
 * Open the URL in the default browser. Resolves true only once the opener has
 * actually started: a missing opener (no xdg-open on a bare Linux) fails AFTER
 * spawn() returns, with an 'error' event, and the caller then prints the URL.
 */
function openInBrowser(platform: string, url: string): Promise<boolean> {
	const [cmd, args] =
		platform === 'win32'
			? ['rundll32', ['url.dll,FileProtocolHandler', url]]
			: platform === 'darwin'
				? ['open', [url]]
				: ['xdg-open', [url]];
	return new Promise((done) => {
		try {
			const child = spawn(cmd as string, args as string[], {
				detached: true,
				stdio: 'ignore',
				windowsHide: true
			});
			child.once('spawn', () => {
				child.unref();
				done(true);
			});
			child.once('error', () => done(false));
		} catch {
			done(false);
		}
	});
}

/**
 * Put the new binary in place. Linux and macOS: copy beside the old one and
 * RENAME over it — a rename replaces a binary that is still executing (that
 * process keeps the old file), where an in-place copy fails with ETXTBSY.
 * Windows cannot replace a running .exe at all, so the agent was stopped first
 * and the copy is retried while the file is still closing or a scanner holds it.
 */
async function installBinary(from: string, to: string, platform: string): Promise<void> {
	mkdirSync(join(to, '..'), { recursive: true });
	const target = platform === 'win32' ? to : `${to}.new-${process.pid}`;
	const start = Date.now();
	for (;;) {
		try {
			copyFileSync(from, target);
			break;
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			const busy = code === 'EBUSY' || code === 'EPERM' || code === 'ETXTBSY';
			if (busy && Date.now() - start < 10_000) {
				await sleep(500);
				continue;
			}
			throw error;
		}
	}
	if (platform !== 'win32') {
		chmodSync(target, 0o755);
		renameSync(target, to);
	}
}

function readConfigState(path: string): 'missing' | 'corrupt' | AgentConfig {
	try {
		return loadConfig(path);
	} catch (error) {
		return error instanceof ConfigMissingError ? 'missing' : 'corrupt';
	}
}

/** Press Enter: a double-clicked Windows console closes the moment the process ends. */
async function holdWindow(platform: string): Promise<void> {
	if (platform !== 'win32' || !process.stdin.isTTY) return;
	process.stdout.write('\nPress Enter to close.\n');
	await new Promise<void>((done) => {
		process.stdin.resume();
		process.stdin.once('data', () => done());
	});
	process.stdin.pause();
}

function reportAutostart(result: AutostartResult, say: (line: string) => void): boolean {
	if (result.ok) {
		say('● Starts when you sign in to this PC');
		return true;
	}
	if ('manual' in result) {
		say('◆ It will not start by itself at sign-in until these are run in a terminal:');
		for (const line of result.manual) say(`    ${line}`);
	} else {
		const why = result.stderr.trim();
		say(`◆ Could not set it to start at sign-in (${result.step})${why ? `: ${why}` : ''}`);
	}
	return false;
}

/**
 * The installer's last line. "Pair this till" only when this run opened
 * pairing (a first install, or a new app address): an update keeps the
 * pairing, and pressing the key then would only answer "Pairing is closed".
 */
export function closingLine(steps: readonly Step[]): string {
	return steps.some((step) => step.kind === 'open-pairing')
		? 'Next: on the till, sign in as the owner → Printer → Pair this till.'
		: 'The till stays paired: nothing to do there.';
}

/** `install` — what running the downloaded file does. Resolves the exit code. */
export async function runInstall(): Promise<number> {
	const platform = process.platform;
	const say = (line: string) => process.stdout.write(line + '\n');
	const configPath = installedConfigPath();
	const exePath = installedExePath(platform);
	const configState = readConfigState(configPath);
	const port = typeof configState === 'object' ? configState.port : DEFAULT_AGENT_PORT;
	const baked = bakedBuild();
	const steps = planInstall({
		platform,
		isRoot: process.getuid?.() === 0,
		baked,
		config: configState,
		agentAnswering: await portAnswers(port),
		exeIsInstalled:
			platform === 'win32'
				? resolve(process.execPath).toLowerCase() === resolve(exePath).toLowerCase()
				: resolve(process.execPath) === resolve(exePath)
	});
	say('matcami print agent — installing for this user');
	let config: AgentConfig | null = typeof configState === 'object' ? configState : null;
	let code = 0;
	for (const step of steps) {
		if (step.kind === 'refuse') {
			say(`✕ ${step.message}`);
			code = 1;
			break;
		}
		try {
			if (!(await runStep(step))) {
				code = 1;
				break;
			}
		} catch (error) {
			// Said in words, never a raw stack: a failed step stops the install.
			say(`✕ ${error instanceof Error ? error.message : String(error)}`);
			code = 1;
			break;
		}
	}
	if (code === 0) say(`\n${closingLine(steps)}`);
	await holdWindow(platform);
	return code;

	/** One step; false = it failed and said why. */
	async function runStep(step: Step): Promise<boolean> {
		if (step.kind === 'create-config' && baked) {
			config = createConfig({ origin: baked.origin, dataDir: join(installDir(), 'data') });
			saveConfig(configPath, config);
			say(`● Settings saved in ${installDir()}`);
		} else if (step.kind === 'update-origin' && config) {
			config = { ...config, origin: step.to };
			saveConfig(configPath, config);
			say(`◆ The app address changed: ${step.from} → ${step.to}. The till must pair again.`);
		} else if (step.kind === 'add-setup-secret' && config) {
			config = { ...config, setupSecret: randomBytes(32).toString('hex') };
			saveConfig(configPath, config);
		} else if (step.kind === 'open-pairing' && config) {
			openPairing(config.dataDir);
			say('● Pairing is open for the till');
		} else if (step.kind === 'stop-agent') {
			if (!(await stopAgent(platform, config))) {
				say('✕ The running print agent did not stop — restart the PC and run this again.');
				return false;
			}
			say('● Stopped the print agent that was running (waiting receipts are kept)');
		} else if (step.kind === 'copy-exe') {
			await installBinary(process.execPath, exePath, platform);
			say(`● Installed ${exePath}`);
		} else if (step.kind === 'register-autostart') {
			const started = reportAutostart(
				registerAutostart(platform, { exePath, dir: installDir() }),
				say
			);
			if (!started) {
				// Start it once now, so the setup page works today.
				const child = spawn(exePath, ['run'], {
					detached: true,
					stdio: 'ignore',
					windowsHide: true
				});
				child.on('error', () => {});
				child.unref();
			}
		} else if (step.kind === 'wait-ready' && config) {
			const live = config;
			const secret = live.setupSecret ?? '';
			const ready = await until(
				async () => (await setupPost(live.port, '/setup/state', secret)).status === 200,
				10_000
			);
			if (!ready) {
				say(`✕ The print agent did not start — see ${join(live.dataDir, 'agent.log')}`);
				return false;
			}
			say(`● Running on http://127.0.0.1:${live.port}`);
		} else if (step.kind === 'open-setup' && config) {
			const url = `http://127.0.0.1:${config.port}/setup#s=${config.setupSecret ?? ''}`;
			// The key is printed only here, to the person installing — never to a log.
			if (!(await openInBrowser(platform, url))) say(`Open this in the browser: ${url}`);
			else say('● Opened the setup page in the browser');
		}
		return true;
	}
}

/** `setup` — open the setup page again, starting the agent first if it is not running. */
export async function runSetup(configPath: string): Promise<number> {
	const platform = process.platform;
	const say = (line: string) => process.stdout.write(line + '\n');
	let config: AgentConfig;
	try {
		config = loadConfig(configPath);
	} catch (error) {
		say(
			error instanceof ConfigMissingError
				? '✕ Run the file you downloaded first.'
				: `✕ ${(error as Error).message}`
		);
		return 1;
	}
	if (!config.setupSecret) {
		say('✕ This config has no setup key: run the file you downloaded again.');
		return 1;
	}
	if (!(await portAnswers(config.port))) {
		if (!isPackaged()) {
			say('✕ The agent is not running. Start it with: node print-agent/src/main.ts run');
			return 1;
		}
		reportAutostart(
			registerAutostart(platform, { exePath: installedExePath(platform), dir: installDir() }),
			say
		);
	}
	const secret = config.setupSecret;
	if (
		!(await until(
			async () => (await setupPost(config.port, '/setup/state', secret)).status === 200,
			10_000
		))
	) {
		say(`✕ The print agent did not answer — see ${join(config.dataDir, 'agent.log')}`);
		return 1;
	}
	const url = `http://127.0.0.1:${config.port}/setup#s=${secret}`;
	if (!(await openInBrowser(platform, url))) say(`Open this in the browser: ${url}`);
	return 0;
}

/** `uninstall` — stop it and remove the sign-in start and the binary; keep the settings and the queue. */
export async function runUninstall(configPath: string): Promise<number> {
	const platform = process.platform;
	const say = (line: string) => process.stdout.write(line + '\n');
	let config: AgentConfig | null = null;
	try {
		config = loadConfig(configPath);
	} catch {
		config = null;
	}
	await stopAgent(platform, config);
	unregisterAutostart(platform);
	const bin = join(installDir(), 'bin');
	try {
		rmSync(bin, { recursive: true, force: true });
		say('● Removed the print agent and its sign-in start.');
	} catch {
		// Windows will not delete the binary that is running this very command.
		say(`● Removed the sign-in start. Delete ${bin} after closing this window.`);
	}
	say(
		`Queued receipts and the pairing are kept in ${installDir()}. Delete that folder to remove them.`
	);
	await holdWindow(platform);
	return 0;
}
