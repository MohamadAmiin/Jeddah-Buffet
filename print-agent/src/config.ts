// THE PRINT AGENT'S CONFIGURATION (spec 11; tasks/menu-and-printing T-24).
//
// The agent is the one listener on the till PC that can open the cash drawer,
// so the file that says who may talk to it is validated field by field here:
// the app origin the browser will send, the 64-hex pairing token, the setup key
// its own setup page presents, the loopback port, and the network printers (raw
// TCP, port 9100 by default) with their paper widths. Anything the parser
// refuses names the field, so the owner can fix `config.json` without reading
// code.
//
// The file is written while the agent runs — by the installer, by the till's
// Printer page and by the agent's setup page (tasks/print-agent-installer) — so
// every write is ATOMIC (writeFileAtomic): a power cut mid-write leaves the old
// file, never a zero-byte one that would lose the token and stop the agent.
//
// THIS FILE IMPORTS ONLY node: BUILTINS AND SIBLINGS WITH .ts EXTENSIONS. The
// agent runs on another machine by `node print-agent/src/main.ts` (Node 24's
// native type stripping), with no install step, so nothing from src/ or from
// node_modules may be reached from here.
import { randomBytes } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync
} from 'node:fs';
import { dirname } from 'node:path';

/** A network ESC/POS printer: raw bytes over TCP, port 9100 by convention. */
export type NetworkPrinter = { host: string; port: number; width: 32 | 48 };
/**
 * A printer this PC already knows — plugged in by USB, or shared — reached by
 * its name in the PC's own print service (CUPS on Linux and macOS, the print
 * spooler on Windows; local-printer.ts). The shape is told apart from a network
 * printer by `name` versus `host`, so every config written before this existed
 * still reads as a network printer, unchanged.
 */
export type LocalPrinter = { name: string; width: 32 | 48 };
export type PrinterConfig = NetworkPrinter | LocalPrinter;

export const isLocalPrinter = (printer: PrinterConfig): printer is LocalPrinter =>
	'name' in printer;

/** A printer's identity in words, for logs and the queue's binding (never its width). */
export function printerLabel(printer: PrinterConfig): string {
	return isLocalPrinter(printer) ? `local:${printer.name}` : `${printer.host}:${printer.port}`;
}

/** Printers with the receipt printer set — what the queue, the drawer and the job parser need. */
export type ReadyPrinters = { receipt: PrinterConfig; kitchen: PrinterConfig | null };

export type AgentConfig = {
	/** The app's exact origin, e.g. https://pos.example.com — what Origin must equal. */
	origin: string;
	/** 64 lowercase hex characters (32 random bytes); a secret, never logged. */
	token: string;
	/**
	 * 64 lowercase hex characters: the key the agent's own setup page
	 * (http://127.0.0.1:<port>/setup) must present. Null in a config written
	 * before the installer existed (the e2e harness's shape), which disables the
	 * setup API. A secret, never logged.
	 */
	setupSecret: string | null;
	/** The loopback port the agent listens on, 1024–65535. */
	port: number;
	/**
	 * `receipt` null = not set up yet: the installer writes the config before
	 * anyone has typed a printer address. `kitchen` null = kitchen tickets ride
	 * the receipt printer.
	 */
	printers: { receipt: PrinterConfig | null; kitchen: PrinterConfig | null };
	/** Where the job queue, the seen-id store and agent.log live. */
	dataDir: string;
};

export const DEFAULT_AGENT_PORT = 9471;
export const DEFAULT_PRINTER_PORT = 9100;

/** `loadConfig` on a path with no file: the installer tells "missing" (install fresh) from "corrupt" (refuse). */
export class ConfigMissingError extends Error {
	constructor(path: string) {
		super(`config: cannot read ${path} — run \`init\` first`);
		this.name = 'ConfigMissingError';
	}
}

function fail(field: string, problem: string): never {
	throw new Error(`config: ${field} ${problem}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(field, 'must be an object');
	}
	return value as Record<string, unknown>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * An https origin with no path, or — for tests and a LAN trial only —
 * http://localhost:<port> or http://127.0.0.1:<port>. Returned normalised
 * (URL.origin), so `https://x/` and `https://x` compare equal.
 */
export function parseOrigin(value: unknown, field = 'origin'): string {
	if (typeof value !== 'string' || value.length === 0) fail(field, 'must be a URL string');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return fail(field, 'is not a valid URL');
	}
	if (
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.username ||
		url.password
	) {
		fail(field, 'must be an origin only — no path, query, hash or credentials');
	}
	const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol === 'https:') return url.origin;
	if (url.protocol === 'http:' && loopback) return url.origin;
	return fail(field, 'must be an https: URL (http: is allowed for localhost and 127.0.0.1 only)');
}

function parsePort(value: unknown, field: string, min: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > 65535) {
		fail(field, `must be an integer from ${min} to 65535`);
	}
	return value;
}

function parseWidth(value: unknown, field: string): 32 | 48 {
	if (value !== 32 && value !== 48) fail(field, 'must be 32 or 48 (58 mm or 80 mm paper)');
	return value;
}

/** A print-service name: 1–120 characters, no control characters, trimmed. */
export const LOCAL_PRINTER_NAME_MAX = 120;

/**
 * One printer — shared with the routes that set printers (server.ts, setup.ts),
 * so every surface validates alike. `{ name, width }` is a printer on this PC;
 * `{ host, port, width }` a network one. A body carrying both is refused.
 */
export function parsePrinter(value: unknown, field: string): PrinterConfig {
	const printer = record(value, field);
	const width = parseWidth(printer.width, `${field}.width`);
	if (printer.name !== undefined && printer.name !== null) {
		if (printer.host !== undefined || printer.port !== undefined) {
			fail(`${field}.name`, 'is a printer on this PC: it has no host or port');
		}
		const name = printer.name;
		if (
			typeof name !== 'string' ||
			name.trim().length === 0 ||
			name.length > LOCAL_PRINTER_NAME_MAX ||
			/[\x00-\x1f\x7f]/.test(name)
		) {
			fail(
				`${field}.name`,
				`must be the printer's name on this PC, 1–${LOCAL_PRINTER_NAME_MAX} characters`
			);
		}
		return { name: name.trim(), width };
	}
	const host = printer.host;
	if (typeof host !== 'string' || host.length === 0 || /[/\s]/.test(host)) {
		fail(`${field}.host`, 'must be a hostname or IP address with no slash or whitespace');
	}
	return {
		host,
		port: parsePort(printer.port, `${field}.port`, 1),
		width
	};
}

function optionalPrinter(value: unknown, field: string): PrinterConfig | null {
	return value === null || value === undefined ? null : parsePrinter(value, field);
}

export function parseConfig(raw: unknown): AgentConfig {
	const config = record(raw, 'config');
	const origin = parseOrigin(config.origin);
	const token = config.token;
	if (typeof token !== 'string' || !HEX64.test(token)) {
		fail('token', 'must be 64 lowercase hex characters');
	}
	const rawSecret = config.setupSecret;
	const setupSecret = rawSecret === null || rawSecret === undefined ? null : rawSecret;
	if (setupSecret !== null && (typeof setupSecret !== 'string' || !HEX64.test(setupSecret))) {
		fail('setupSecret', 'must be 64 lowercase hex characters');
	}
	const port = parsePort(config.port, 'port', 1024);
	const printers = record(config.printers, 'printers');
	const receipt = optionalPrinter(printers.receipt, 'printers.receipt');
	const kitchen = optionalPrinter(printers.kitchen, 'printers.kitchen');
	if (kitchen !== null && receipt === null) {
		fail('printers.kitchen', 'needs a receipt printer first');
	}
	const dataDir = config.dataDir;
	if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
		fail('dataDir', 'must be a non-empty path');
	}
	return { origin, token, setupSecret, port, printers: { receipt, kitchen }, dataDir };
}

export function loadConfig(path: string): AgentConfig {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') throw new ConfigMissingError(path);
		throw new Error(`config: cannot read ${path} — run \`init\` first`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`config: ${path} is not valid JSON`);
	}
	return parseConfig(raw);
}

/** `host[:port]` as typed on the command line, or `local:<name>` for a printer on this PC. */
export function parsePrinterAddress(value: string, width: 32 | 48): PrinterConfig {
	if (value.trim().startsWith('local:')) {
		return parsePrinter({ name: value.trim().slice('local:'.length), width }, 'printer');
	}
	const match = /^(.+?)(?::(\d{1,5}))?$/.exec(value.trim());
	if (!match || !match[1]) throw new Error(`printer address "${value}" is not host[:port]`);
	const host = match[1];
	const port = match[2] === undefined ? DEFAULT_PRINTER_PORT : Number.parseInt(match[2], 10);
	return parsePrinter({ host, port, width }, 'printer');
}

/** The one place a write can be made to fail in a test (config.test.ts); nothing else reads it. */
export const writeSeam = { renameSync };

/**
 * Replace `path` with `text` all at once: write a temporary file beside it
 * (created with `mode`, so it is never readable by others even for a moment),
 * flush it to disk, then rename it over the target. A crash at any point leaves
 * either the old file or the new one — never a truncated one. `rename` replaces
 * an existing target on Windows too (Node uses MOVEFILE_REPLACE_EXISTING), so
 * the target is never deleted first.
 */
export function writeFileAtomic(path: string, text: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
	try {
		const fd = openSync(tmp, 'wx', mode);
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		writeSeam.renameSync(tmp, path);
		// `mode` on open is masked by the umask; Windows has no POSIX modes (the
		// installer keeps the folder inside the user's own profile there).
		if (process.platform !== 'win32') chmodSync(path, mode);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** Write a config — checked by the same parser that will read it back, so a file that would not load is never written. */
export function saveConfig(path: string, config: AgentConfig): void {
	const checked = parseConfig(config);
	writeFileAtomic(path, JSON.stringify(checked, null, '\t') + '\n');
}

/** A new config with a fresh pairing token and setup key, and no printers unless given. */
export function createConfig(args: {
	origin: string;
	port?: number;
	dataDir: string;
	printers?: AgentConfig['printers'];
}): AgentConfig {
	return parseConfig({
		origin: args.origin,
		token: randomBytes(32).toString('hex'),
		setupSecret: randomBytes(32).toString('hex'),
		port: args.port ?? DEFAULT_AGENT_PORT,
		printers: args.printers ?? { receipt: null, kitchen: null },
		dataDir: args.dataDir
	});
}

export type InitArgs = {
	origin: string;
	receipt?: PrinterConfig | null;
	kitchen?: PrinterConfig | null;
	port?: number;
	dataDir: string;
	force?: boolean;
};

/**
 * Write a fresh config with a random 64-hex token. Refuses to overwrite an
 * existing file unless `force`, so a re-run cannot silently re-key a paired
 * till. Returns the config it wrote — the caller prints the token ONCE.
 */
export function initConfig(path: string, args: InitArgs): AgentConfig {
	if (existsSync(path) && !args.force) {
		throw new Error(
			`config: ${path} already exists — pass --force to replace it (the till must then be paired again)`
		);
	}
	const config = createConfig({
		origin: args.origin,
		port: args.port,
		dataDir: args.dataDir,
		printers: { receipt: args.receipt ?? null, kitchen: args.kitchen ?? null }
	});
	// A --force over a file copied or hand-written at 0644 still ends at 0600:
	// the rename puts a NEW file, created 0600, in its place.
	saveConfig(path, config);
	return config;
}
