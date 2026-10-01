// THE PRINT AGENT'S COMMAND LINE (spec 11; tasks/menu-and-printing T-24).
//
//   node print-agent/src/main.ts init --origin <url> --receipt <host[:port]> --width <32|48>
//        [--kitchen <host[:port]>] [--kitchen-width <32|48>] [--port <n>] [--config <path>] [--force]
//   node print-agent/src/main.ts pair [--config <path>]
//   node print-agent/src/main.ts link [--config <path>]
//   node print-agent/src/main.ts run [--config <path>]
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
import { resolve } from 'node:path';
import {
	DEFAULT_AGENT_PORT,
	initConfig,
	loadConfig,
	parsePrinterAddress,
	type AgentConfig
} from './config.ts';
import { claimPairing, openPairing } from './pairing.ts';
import { createDrawer, createQueue } from './queue.ts';
import { createAgentServer, listen } from './server.ts';

const HERE = import.meta.dirname;
export const DEFAULT_CONFIG_PATH = resolve(HERE, '..', 'config.json');
export const DEFAULT_DATA_DIR = resolve(HERE, '..', 'data');

const USAGE = `matcami print agent

Usage:
  node print-agent/src/main.ts init --origin <url> --receipt <host[:port]> --width <32|48>
       [--kitchen <host[:port]>] [--kitchen-width <32|48>] [--port <n>]
       [--config <path>] [--force]
  node print-agent/src/main.ts pair [--config <path>]
  node print-agent/src/main.ts link [--config <path>]
  node print-agent/src/main.ts run [--config <path>]
  node print-agent/src/main.ts --help

init   writes ${DEFAULT_CONFIG_PATH} (or --config) with a fresh pairing secret and
       opens pairing. It refuses to overwrite an existing file without --force.
pair   opens pairing: on the till, Printer → "Pair this till". It stays open
       until one till pairs — the first to ask — and then closes.
link   prints a pairing link instead — pairs a till without opening pairing.
       The link carries the secret.
run    starts the agent on 127.0.0.1:<port> (default ${DEFAULT_AGENT_PORT}).

--origin        the app's https address exactly as the till opens it, e.g. https://pos.example.com
--receipt       the receipt printer, host[:port]; the port defaults to 9100 (raw TCP)
--width         the receipt printer's columns: 32 (58 mm) or 48 (80 mm)
--kitchen       the kitchen printer, host[:port]; without one, kitchen tickets print on the receipt printer
--kitchen-width the kitchen printer's columns: 32 or 48 (defaults to --width)
--port          the agent's loopback port, 1024-65535 (default ${DEFAULT_AGENT_PORT})
--config        the config file to write or read
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
	const receiptAddress = text(flags, 'receipt');
	if (!receiptAddress) throw new Error('--receipt is required');
	const receiptWidth = width(flags, 'width');
	const kitchenAddress = text(flags, 'kitchen');
	const portText = text(flags, 'port');
	const path = text(flags, 'config') ?? DEFAULT_CONFIG_PATH;
	const config = initConfig(path, {
		origin,
		receipt: parsePrinterAddress(receiptAddress, receiptWidth),
		kitchen: kitchenAddress
			? parsePrinterAddress(kitchenAddress, width(flags, 'kitchen-width', receiptWidth))
			: null,
		port: portText === undefined ? undefined : Number.parseInt(portText, 10),
		dataDir: DEFAULT_DATA_DIR,
		force: flags.force === true
	});
	return { path, config };
}

async function runServer(config: AgentConfig): Promise<void> {
	const queue = createQueue({ dataDir: config.dataDir, printers: config.printers });
	const drawer = createDrawer({
		receipt: config.printers.receipt,
		seen: queue.seen,
		log: queue.log
	});
	const server = createAgentServer(config, {
		submitJob: queue.submit,
		pulseDrawer: drawer.pulse,
		status: queue.status,
		claimPairing: () => claimPairing(config.dataDir)
	});
	const port = await listen(server, config.port);
	// The URL, never the token.
	process.stdout.write(`matcami print agent listening on http://127.0.0.1:${port}\n`);
	const shutdown = () => {
		// Let a print already on the wire finish and be recorded, then leave.
		void queue.close().then(() => server.close(() => process.exit(0)));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

function main(argv: string[]): number {
	const { command, flags } = parseFlags(argv);
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
		const config = loadConfig(text(flags, 'config') ?? DEFAULT_CONFIG_PATH);
		process.stdout.write(openPairingLines(config).join('\n'));
		return 0;
	}
	if (command === 'link') {
		const config = loadConfig(text(flags, 'config') ?? DEFAULT_CONFIG_PATH);
		process.stdout.write(linkLines(config).join('\n'));
		return 0;
	}
	if (command === 'run') {
		// Loaded first so a broken file fails here, with the field named, not at
		// the first print job.
		const config = loadConfig(text(flags, 'config') ?? DEFAULT_CONFIG_PATH);
		void runServer(config);
		return 0;
	}
	process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
	return 1;
}

// Only when executed directly — main.test.ts imports runInit and parseFlags.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
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
