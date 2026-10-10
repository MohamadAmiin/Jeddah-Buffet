// THE PRINT AGENT'S COMMAND LINE (spec 11; tasks/menu-and-printing T-24).
//
//   node print-agent/src/main.ts init --origin <url> [--receipt <host[:port]> --width <32|48>]
//        [--kitchen <host[:port]>] [--kitchen-width <32|48>] [--port <n>] [--config <path>] [--force]
//   node print-agent/src/main.ts pair [--config <path>]
//   node print-agent/src/main.ts link [--config <path>]
//   node print-agent/src/main.ts run [--config <path>]
//   node print-agent/src/main.ts --version
//   node print-agent/src/main.ts --help
//
// NOBODY TYPES THE PAIRING SECRET. `init` and `pair` open pairing (pairing.ts);
// the owner presses "Pair this till" on the Printer screen and the agent hands
// that till the secret, once, and pairing closes. `link` is the way that opens
// nothing: it prints `<origin>/pos/printer#agent=…&token=…`, and opening that on
// the till pairs it — the secret rides in the FRAGMENT, which a browser never
// sends to any server, so the app never sees it.
//
// Zero dependencies: node: builtins and sibling files with .ts extensions only,
// run directly by Node 24's type stripping (only erasable syntax — no enum, no
// namespace, no parameter properties; tsconfig's erasableSyntaxOnly refuses them
// first). `run` wires the disk queue, the drawer and the server together.
//
// The same file is the entry point of the one-file installer (a Node 24 single
// executable application; tasks/print-agent-installer): paths.ts decides where
// config.json and data/ live in each mode, and the entry guard at the bottom runs
// main() both when Node starts this file and when the installer starts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { nextDelay } from './autostart.ts';
import {
	DEFAULT_AGENT_PORT,
	initConfig,
	loadConfig,
	parsePrinterAddress,
	type AgentConfig,
	type PrinterConfig
} from './config.ts';
import { claimPairing, openPairing, pairingState } from './pairing.ts';
import { bakedBuild, defaultPaths, isPackaged, selfCommand } from './paths.ts';
import { createRuntime, type Runtime } from './runtime.ts';
import { AGENT_FEATURES, createAgentServer, listen, type AgentDeps } from './server.ts';
import { SETUP_CSS, SETUP_HTML, SETUP_JS } from './setup-page.ts';
import { createSetupHandler } from './setup.ts';

const USAGE = `matcami print agent

Usage:
  node print-agent/src/main.ts init --origin <url> [--receipt <host[:port]> --width <32|48>]
       [--kitchen <host[:port]>] [--kitchen-width <32|48>] [--port <n>]
       [--config <path>] [--force]
  node print-agent/src/main.ts pair [--config <path>]
  node print-agent/src/main.ts link [--config <path>]
  node print-agent/src/main.ts run [--config <path>]
  node print-agent/src/main.ts --version
  node print-agent/src/main.ts --help

init   writes the agent's config.json (or --config) with a fresh pairing secret and
       opens pairing. It refuses to overwrite an existing file without --force.
pair   opens pairing: on the till, Printer → "Pair this till". It stays open
       until one till pairs — the first to ask — and then closes.
link   prints a pairing link instead — pairs a till without opening pairing.
       The link carries the secret.
run    starts the agent on 127.0.0.1:<port> (default ${DEFAULT_AGENT_PORT}).
--version  prints the agent's version and, for an installer, the app address it answers.

--origin        the app's https address exactly as the till opens it, e.g. https://pos.example.com
--receipt       the receipt printer, host[:port]; the port defaults to 9100 (raw TCP).
                Optional: it can be set later on the till's Printer page
--width         the receipt printer's columns: 32 (58 mm) or 48 (80 mm); needs --receipt
--kitchen       the kitchen printer, host[:port]; without one, kitchen tickets print on the receipt printer
--kitchen-width the kitchen printer's columns: 32 or 48 (defaults to --width)
--port          the agent's loopback port, 1024-65535 (default ${DEFAULT_AGENT_PORT})
--config        the config file to write or read (default: the agent's config.json)
--force         replace an existing config (the till must be paired again)
`;

type Flags = Record<string, string | true>;

/** `--name value` and `--flag` pairs, in order; a repeated flag keeps the last value. */
export function parseFlags(argv: string[]): { command: string | null; flags: Flags } {
	const flags: Flags = {};
	let command: string | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? '';
		if (arg.startsWith('--')) {
			const name = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				flags[name] = next;
				i += 1;
			} else {
				flags[name] = true;
			}
		} else if (command === null) {
			command = arg;
		} else {
			throw new Error(`unexpected argument "${arg}"`);
		}
	}
	return { command, flags };
}

function text(flags: Flags, name: string): string | undefined {
	const value = flags[name];
	return typeof value === 'string' ? value : undefined;
}

function width(flags: Flags, name: string, fallback?: 32 | 48): 32 | 48 {
	const value = text(flags, name);
	if (value === undefined) {
		if (fallback) return fallback;
		throw new Error(`--${name} is required (32 or 48)`);
	}
	if (value === '32') return 32;
	if (value === '48') return 48;
	throw new Error(`--${name} must be 32 or 48`);
}

/**
 * The link that pairs a till: the app's own Printer screen, with the agent's
 * loopback address and the pairing secret in the FRAGMENT (never sent to a
 * server). src/lib/pos/print-client.ts parsePairingFragment reads it.
 */
export function pairingLink(config: Pick<AgentConfig, 'origin' | 'token' | 'port'>): string {
	const pairing = new URLSearchParams({
		agent: `http://127.0.0.1:${config.port}`,
		token: config.token
	});
	return `${config.origin}/pos/printer#${pairing.toString()}`;
}

function linkLines(config: AgentConfig): string[] {
	return [
		`Agent URL:     http://127.0.0.1:${config.port}`,
		`Pairing link:  ${pairingLink(config)}`,
		'Open the link once in Chrome on the till. The owner signs in and the till pairs itself.',
		'The link carries the pairing secret: never paste it into a chat or commit it.',
		''
	];
}

/** Open pairing and say what to press. Prints no secret. */
function openPairingLines(config: AgentConfig): string[] {
	openPairing(config.dataDir);
	return [
		`Agent URL:     http://127.0.0.1:${config.port}`,
		'Pairing is open until one till pairs.',
		'On the till, signed in as the owner: Printer → "Pair this till".',
		'The first till to ask is paired, and pairing closes. Run `pair` to open it again.',
		''
	];
}

/** The `init` command, as a function so the test can call it without a process. */
export function runInit(flags: Flags): { path: string; config: AgentConfig } {
	const origin = text(flags, 'origin');
	if (!origin) throw new Error('--origin is required');
	// The printers are optional: they can be set later on the till's Printer page
	// or the agent's own setup page (tasks/print-agent-installer).
	const receiptAddress = text(flags, 'receipt');
	const kitchenAddress = text(flags, 'kitchen');
	if (!receiptAddress && kitchenAddress) throw new Error('--kitchen needs --receipt');
	if (!receiptAddress && flags.width !== undefined) throw new Error('--width needs --receipt');
	let receipt: PrinterConfig | null = null;
	let kitchen: PrinterConfig | null = null;
	if (receiptAddress) {
		const receiptWidth = width(flags, 'width');
		receipt = parsePrinterAddress(receiptAddress, receiptWidth);
		if (kitchenAddress) {
			kitchen = parsePrinterAddress(kitchenAddress, width(flags, 'kitchen-width', receiptWidth));
		}
	}
	const portText = text(flags, 'port');
	const path = text(flags, 'config') ?? defaultPaths().configPath;
	const config = initConfig(path, {
		origin,
		receipt,
		kitchen,
		port: portText === undefined ? undefined : Number.parseInt(portText, 10),
		dataDir: defaultPaths().dataDir,
		force: flags.force === true
	});
	return { path, config };
}

async function runServer(configPath: string, config: AgentConfig): Promise<void> {
	// THE PORT IS THE SINGLE-INSTANCE LOCK, so it is bound BEFORE the queue
	// exists: a second copy (a second sign-in trigger, a double-click) must find
	// the port taken and leave without its queue ever resuming the jobs on disk —
	// two queues on one data/ would print every waiting receipt twice. Until the
	// runtime is built every dependency falls back to "no printer"; nothing can
	// reach them in between, because the runtime is built in the same tick that
	// `listen` resolves, before any connection is handled.
	let runtime: Runtime | null = null;
	let setup: AgentDeps['setup'] | null = null;
	const server = createAgentServer(() => runtime?.config() ?? config, {
		submitJob: (job) => runtime?.deps.submitJob(job) ?? 'no_printer',
		pulseDrawer: async (request) => (runtime ? runtime.deps.pulseDrawer(request) : 'no_printer'),
		status: async () =>
			runtime
				? runtime.deps.status()
				: { agentVersion: 2, features: AGENT_FEATURES, printers: { receipt: null, kitchen: null } },
		setPrinters: async (printers) => {
			if (!runtime) throw new Error('the agent is still starting');
			return runtime.deps.setPrinters(printers);
		},
		claimPairing: () => claimPairing((runtime?.config() ?? config).dataDir),
		setup: async (req, res, ctx) => (setup ? setup(req, res, ctx) : false)
	});
	let port: number;
	try {
		port = await listen(server, config.port);
	} catch (error) {
		if ((error as { code?: unknown }).code === 'EADDRINUSE') {
			// Another agent already holds the port: not a failure, so no supervisor
			// (systemd, launchd, the Windows supervisor) restarts this one in a loop.
			mkdirSync(config.dataDir, { recursive: true });
			appendFileSync(
				join(config.dataDir, 'agent.log'),
				`${new Date().toISOString()} already running on 127.0.0.1:${config.port}\n`
			);
			process.stdout.write(`matcami print agent is already running on 127.0.0.1:${config.port}\n`);
			process.exit(0);
		}
		throw error;
	}
	// The runtime builds the queue and the drawer once a receipt printer is set,
	// and rebuilds them when the printers change (runtime.ts).
	const live = createRuntime({ configPath, config });
	runtime = live;
	const dataDir = () => live.config().dataDir;
	setup = createSetupHandler({
		runtime: live,
		openPairing: () => openPairing(dataDir()),
		pairingState: () => pairingState(dataDir()),
		rekey: async () => {
			await live.setToken(randomBytes(32).toString('hex'));
			openPairing(dataDir());
		},
		quit: () => shutdown(),
		page: { html: SETUP_HTML, js: SETUP_JS, css: SETUP_CSS }
	});
	// The URL, never the token.
	process.stdout.write(`matcami print agent listening on http://127.0.0.1:${port}\n`);
	const shutdown = () => {
		// Let a print already on the wire finish and be recorded, then leave.
		void live.close().then(() => server.close(() => process.exit(0)));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

/** `--config <path>` passed on to a relaunched copy, when one was given. */
function configArgs(flags: Flags): string[] {
	const path = text(flags, 'config');
	return path ? ['--config', path] : [];
}

/**
 * `run --detach` (the Windows logon task): start `run --supervise` with no
 * console — on Windows `detached` means DETACHED_PROCESS — and return at once.
 * The only window anyone sees is this launcher's sub-second flash.
 */
function detach(flags: Flags): void {
	const self = selfCommand(['run', '--supervise', ...configArgs(flags)]);
	spawn(self.command, self.args, { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

/**
 * `run --supervise`: keep a console-less `run` going. A clean exit (0 — a quit
 * from the setup page, or "already running") ends supervision; a crash is
 * restarted after nextDelay. SIGTERM/SIGINT are passed on to the worker.
 */
async function supervise(flags: Flags): Promise<number> {
	const self = selfCommand(['run', ...configArgs(flags)]);
	let worker: ChildProcess | null = null;
	let stopping = false;
	const stop = () => {
		stopping = true;
		worker?.kill('SIGTERM');
	};
	process.once('SIGTERM', stop);
	process.once('SIGINT', stop);
	let delay = 0;
	for (;;) {
		const started = Date.now();
		const child = spawn(self.command, self.args, { windowsHide: true, stdio: 'ignore' });
		worker = child;
		const code = await new Promise<number | null>((resolve) => {
			child.once('exit', (exitCode) => resolve(exitCode));
			child.once('error', () => resolve(-1));
		});
		if (stopping || code === 0) return 0;
		delay = nextDelay(delay, Date.now() - started);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}

/** `--version`: the protocol version, and for an installer when it was built and which app it answers. */
export function versionLine(): string {
	const build = bakedBuild();
	return build
		? `matcami print agent ${build.agentVersion} (built ${build.builtAt}) for ${build.origin}`
		: 'matcami print agent 2 (source)';
}

function main(argv: string[]): number {
	const { command, flags } = parseFlags(argv);
	if (flags.version === true) {
		process.stdout.write(versionLine() + '\n');
		return 0;
	}
	if (command === null || flags.help === true) {
		process.stdout.write(USAGE);
		return command === null && flags.help !== true ? 1 : 0;
	}
	if (command === 'init') {
		const { path, config } = runInit(flags);
		process.stdout.write([`Wrote ${path}`, ...openPairingLines(config)].join('\n'));
		return 0;
	}
	if (command === 'pair') {
		const config = loadConfig(text(flags, 'config') ?? defaultPaths().configPath);
		process.stdout.write(openPairingLines(config).join('\n'));
		return 0;
	}
	if (command === 'link') {
		const config = loadConfig(text(flags, 'config') ?? defaultPaths().configPath);
		process.stdout.write(linkLines(config).join('\n'));
		return 0;
	}
	if (command === 'run') {
		// The Windows logon task's launcher: start a console-less supervisor, leave.
		if (flags.detach === true) {
			detach(flags);
			return 0;
		}
		if (flags.supervise === true) {
			void supervise(flags).then((code) => process.exit(code));
			return 0;
		}
		// Loaded first so a broken file fails here, with the field named, not at
		// the first print job.
		const configPath = text(flags, 'config') ?? defaultPaths().configPath;
		const config = loadConfig(configPath);
		void runServer(configPath, config);
		return 0;
	}
	process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
	return 1;
}

// Only when executed — main.test.ts imports runInit and parseFlags. Node sets
// import.meta.main on the module it started (`node print-agent/src/main.ts`);
// inside the installer the bundle defines it away and isPackaged() is the signal.
// A packaged process.argv is [execPath, execPath, ...args], so slice(2) holds.
if (isPackaged() || import.meta.main) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
	process.on('unhandledRejection', (error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
