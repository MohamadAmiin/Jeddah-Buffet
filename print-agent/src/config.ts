// THE PRINT AGENT'S CONFIGURATION (spec 11; tasks/menu-and-printing T-24).
//
// The agent is the one listener on the till PC that can open the cash drawer,
// so the file that says who may talk to it is validated field by field here:
// the app origin the browser will send, the 64-hex pairing token, the loopback
// port, and the network printers (raw TCP, port 9100 by default) with their
// paper widths. Anything the parser refuses names the field, so the owner can
// fix `config.json` without reading code.
//
// THIS FILE IMPORTS ONLY node: BUILTINS AND SIBLINGS WITH .ts EXTENSIONS. The
// agent runs on another machine by `node print-agent/src/main.ts` (Node 24's
// native type stripping), with no install step, so nothing from src/ or from
// node_modules may be reached from here.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PrinterConfig = { host: string; port: number; width: 32 | 48 };

export type AgentConfig = {
	/** The app's exact origin, e.g. https://pos.example.com — what Origin must equal. */
	origin: string;
	/** 64 lowercase hex characters (32 random bytes); a secret, never logged. */
	token: string;
	/** The loopback port the agent listens on, 1024–65535. */
	port: number;
	printers: { receipt: PrinterConfig; kitchen: PrinterConfig | null };
	/** Where the job queue, the seen-id store and agent.log live. */
	dataDir: string;
};

export const DEFAULT_AGENT_PORT = 9471;
export const DEFAULT_PRINTER_PORT = 9100;

function fail(field: string, problem: string): never {
	throw new Error(`config: ${field} ${problem}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		fail(field, 'must be an object');
	}
	return value as Record<string, unknown>;
}

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

function parsePrinter(value: unknown, field: string): PrinterConfig {
	const printer = record(value, field);
	const host = printer.host;
	if (typeof host !== 'string' || host.length === 0 || /[/\s]/.test(host)) {
		fail(`${field}.host`, 'must be a hostname or IP address with no slash or whitespace');
	}
	return {
		host,
		port: parsePort(printer.port, `${field}.port`, 1),
		width: parseWidth(printer.width, `${field}.width`)
	};
}

export function parseConfig(raw: unknown): AgentConfig {
	const config = record(raw, 'config');
	const origin = parseOrigin(config.origin);
	const token = config.token;
	if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
		fail('token', 'must be 64 lowercase hex characters');
	}
	const port = parsePort(config.port, 'port', 1024);
	const printers = record(config.printers, 'printers');
	const receipt = parsePrinter(printers.receipt, 'printers.receipt');
	const kitchen =
		printers.kitchen === null || printers.kitchen === undefined
			? null
			: parsePrinter(printers.kitchen, 'printers.kitchen');
	const dataDir = config.dataDir;
	if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
		fail('dataDir', 'must be a non-empty path');
	}
	return { origin, token, port, printers: { receipt, kitchen }, dataDir };
}

export function loadConfig(path: string): AgentConfig {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
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

/** `host[:port]` as typed on the command line. */
export function parsePrinterAddress(value: string, width: 32 | 48): PrinterConfig {
	const match = /^(.+?)(?::(\d{1,5}))?$/.exec(value.trim());
	if (!match || !match[1]) throw new Error(`printer address "${value}" is not host[:port]`);
	const host = match[1];
	const port = match[2] === undefined ? DEFAULT_PRINTER_PORT : Number.parseInt(match[2], 10);
	return parsePrinter({ host, port, width }, 'printer');
}

export type InitArgs = {
	origin: string;
	receipt: PrinterConfig;
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
	const config = parseConfig({
		origin: args.origin,
		token: randomBytes(32).toString('hex'),
		port: args.port ?? DEFAULT_AGENT_PORT,
		printers: { receipt: args.receipt, kitchen: args.kitchen ?? null },
		dataDir: args.dataDir
	});
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, '\t') + '\n', { mode: 0o600 });
	return config;
}
