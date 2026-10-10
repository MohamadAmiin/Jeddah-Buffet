// THE PRINT AGENT'S HTTP SERVER (spec 11; tasks/menu-and-printing T-25).
//
// It binds 127.0.0.1 ONLY and answers exactly one origin: the till. Every
// request, preflighted or not, passes the same three walls IN THIS ORDER before
// any route runs — Host (defeats DNS rebinding), Origin (only the configured app
// may talk to it; a request with no Origin is refused too), then the Bearer
// token compared in constant time. CORS headers alone protect nothing: a page
// can send a "simple" request with no preflight, so the checks are on every
// request and the token is never logged.
//
// ONE route runs after the first two walls and before the third: POST /pair,
// whose whole job is to hand the till its token. It answers only while the
// pairing is open and only once per opening (pairing.ts) — the single
// place the token is ever sent. The origin it compares against is the one baked
// into the installer or written by `init`, NEVER one adopted from a request
// (tasks/print-agent-installer, the BLOCKER of its risk panel): an agent that
// trusted the first page to pair would hand the drawer to any page on the PC.
//
// PUT /printers (tasks/print-agent-installer T-04) runs after all three walls:
// the till's Printer page sets the printer address and paper width with the
// pairing token, and the runtime re-wires the queue and the drawer around it.
//
// The agent is the one program on the till PC that can open the cash drawer,
// which is why the drawer is its own endpoint (T-26 never queues or replays it)
// and why a job's lines are validated here: text to printable ASCII within the
// target printer's width, or an image to an exact shape — a width that is a
// multiple of 8 up to the printer's dots, a height up to MAX_IMAGE_HEIGHT_DOTS,
// and canonical base64 of exactly widthDots / 8 × heightDots bytes
// (settings-tax-payments-receipt T-25). The encoder (escpos.ts) is the second
// wall for both.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
	DEFAULT_PRINTER_PORT,
	parsePrinter,
	type AgentConfig,
	type ReadyPrinters
} from './config.ts';
import { DOTS, MAX_IMAGE_HEIGHT_DOTS } from './escpos.ts';
import type { LocalPrinterInfo } from './local-printer.ts';
import type { PairingClaim } from './pairing.ts';

export type TextLine = {
	text: string;
	bold?: boolean;
	size?: 'normal' | 'tall' | 'double';
	align?: 'left' | 'center';
};
/**
 * A picture as plain pixel data, never printer bytes. `bitmap` is STANDARD
 * base64 with `=` padding, exactly as the till's cached logo carries it
 * (GET /api/pos/receipt-logo): 1-bit rows of widthDots / 8 bytes, most
 * significant bit first, 1 = black — the GS v 0 raster format, so the agent
 * never inverts or reorders a bit.
 */
export type ImageLine = { image: { widthDots: number; heightDots: number; bitmap: string } };
export type PrintLine = TextLine | ImageLine;
export type Job = { id: string; printer: 'receipt' | 'kitchen'; lines: PrintLine[]; cut: boolean };
export type DrawerRequest = { id: string; completedAt: string };
/**
 * What this agent can do beyond printing, so a till can tell an agent that sets
 * printers (PUT /printers) and serves a setup page from an older one before it
 * sends anything (tasks/print-agent-installer). Additive: old tills ignore it.
 */
export const AGENT_FEATURES = ['printers', 'setup', 'local-printers'] as const;
/**
 * `host`/`port`, or `name` for a printer on this PC, let the till bind a logo
 * confirmation to ONE printer (T-14). `queued` counts what the agent holds —
 * and, for a printer on this PC, what the print service still holds for it.
 */
export type PrinterStatus = ({ host: string; port: number } | { name: string }) & {
	width: 32 | 48;
	reachable: boolean;
	queued: number;
};
export type AgentStatus = {
	agentVersion: 2;
	features: readonly string[];
	/** `receipt` null: no printer set yet — the installer runs before anyone types an address. */
	printers: { receipt: PrinterStatus | null; kitchen: PrinterStatus | null };
};
export type SubmitOutcome = 'queued' | 'duplicate' | 'no_printer';
export type DrawerOutcome =
	'opened' | 'duplicate' | 'too_late' | 'printer_unreachable' | 'no_printer';
/** A paper-width change is refused while that printer has jobs encoded for the old width. */
export type SetPrintersOutcome =
	| { ok: true }
	| { ok: false; error: 'jobs_waiting'; target: 'receipt' | 'kitchen'; queued: number };

export type AgentDeps = {
	submitJob: (job: Job) => SubmitOutcome | Promise<SubmitOutcome>;
	pulseDrawer: (request: DrawerRequest) => Promise<DrawerOutcome>;
	status: () => Promise<AgentStatus>;
	/** Re-point the queue and the drawer at new printers (runtime.ts). */
	setPrinters: (printers: AgentConfig['printers']) => Promise<SetPrintersOutcome>;
	/** The printers this PC's print service knows (local-printer.ts) — what the Printer page offers to pick. */
	listLocalPrinters: () => Promise<LocalPrinterInfo[]>;
	/** Take open pairing's one claim (pairing.ts claimPairing). */
	claimPairing: () => PairingClaim;
	/**
	 * The agent's own setup page and API (setup.ts createSetupHandler). It has
	 * walls of its own and answers the agent's OWN loopback origin, so it runs
	 * after the Host wall and before the Origin wall; true = it answered.
	 */
	setup?: (
		req: IncomingMessage,
		res: ServerResponse,
		ctx: { boundPort: number; config: AgentConfig }
	) => Promise<boolean>;
};

export const MAX_BODY_BYTES = 65_536;
/** A receipt carries one logo; the cap stops a job from becoming a picture dump that holds the printer. */
export const MAX_IMAGE_LINES = 2;
const ID = /^[A-Za-z0-9:_-]{1,100}$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SIZES = new Set(['normal', 'tall', 'double']);
const ALIGNS = new Set(['left', 'center']);

export class BadRequest extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.name = 'BadRequest';
		this.detail = detail;
	}
}

function obj(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new BadRequest(`${what} must be an object`);
	}
	return value as Record<string, unknown>;
}

function id(value: unknown): string {
	if (typeof value !== 'string' || !ID.test(value)) {
		throw new BadRequest('id must be 1-100 characters of A-Z a-z 0-9 : _ -');
	}
	return value;
}

/**
 * An image line is `{ image: { widthDots, heightDots, bitmap } }` and nothing
 * else — no text, no attribute, no extra field — in the exact shape the
 * encoder's raster header will fix for the target printer. `bitmap` must be
 * STANDARD base64 with `=` padding that decodes to EXACTLY widthDots / 8 ×
 * heightDots bytes: the canonical round trip refuses URL-safe characters,
 * missing padding and non-zero trailing bits, all of which Node's lenient
 * decoder accepts silently. Returns a FRESH object, never the input.
 */
function imageLine(l: Record<string, unknown>, i: number, width: 32 | 48): ImageLine {
	if (Object.keys(l).length !== 1) {
		throw new BadRequest(`lines[${i}] with an image must have no other key`);
	}
	const image = obj(l.image, `lines[${i}].image`);
	if (Object.keys(image).sort().join(',') !== 'bitmap,heightDots,widthDots') {
		throw new BadRequest(
			`lines[${i}].image must have exactly the keys widthDots, heightDots and bitmap`
		);
	}
	const { widthDots, heightDots, bitmap } = image;
	if (
		typeof widthDots !== 'number' ||
		!Number.isInteger(widthDots) ||
		widthDots % 8 !== 0 ||
		widthDots < 8 ||
		widthDots > DOTS[width]
	) {
		throw new BadRequest(
			`lines[${i}].image.widthDots must be a multiple of 8 from 8 to ${DOTS[width]} on a ${width}-column printer`
		);
	}
	if (
		typeof heightDots !== 'number' ||
		!Number.isInteger(heightDots) ||
		heightDots < 1 ||
		heightDots > MAX_IMAGE_HEIGHT_DOTS
	) {
		throw new BadRequest(
			`lines[${i}].image.heightDots must be an integer from 1 to ${MAX_IMAGE_HEIGHT_DOTS}`
		);
	}
	if (typeof bitmap !== 'string') {
		throw new BadRequest(`lines[${i}].image.bitmap must be a base64 string`);
	}
	const expected = (widthDots / 8) * heightDots;
	const chars = 4 * Math.ceil(expected / 3);
	if (bitmap.length !== chars) {
		throw new BadRequest(
			`lines[${i}].image.bitmap must be ${chars} base64 characters for ${expected} bytes`
		);
	}
	const decoded = Buffer.from(bitmap, 'base64');
	if (decoded.length !== expected || decoded.toString('base64') !== bitmap) {
		throw new BadRequest(
			`lines[${i}].image.bitmap must be standard base64 of exactly ${expected} bytes`
		);
	}
	return { image: { widthDots, heightDots, bitmap } };
}

/**
 * A print job as the till sends it. The target printer decides the width: a
 * kitchen job goes to the kitchen printer, or to the receipt printer when none
 * is configured (assumption 7). A 'double' line holds half the columns; an
 * image line is at most the printer's dots wide and MAX_IMAGE_HEIGHT_DOTS
 * tall, and a job carries at most MAX_IMAGE_LINES of them.
 */
export function parseJob(raw: unknown, printers: ReadyPrinters): Job {
	const body = obj(raw, 'job');
	const jobId = id(body.id);
	if (body.printer !== 'receipt' && body.printer !== 'kitchen') {
		throw new BadRequest("printer must be 'receipt' or 'kitchen'");
	}
	const printer = body.printer;
	const target = printer === 'kitchen' && printers.kitchen ? printers.kitchen : printers.receipt;
	if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 400) {
		throw new BadRequest('lines must be an array of 1-400 lines');
	}
	let imageLines = 0;
	const lines: PrintLine[] = body.lines.map((entry, i): PrintLine => {
		const l = obj(entry, `lines[${i}]`);
		if (Object.hasOwn(l, 'image')) {
			imageLines += 1;
			return imageLine(l, i, target.width);
		}
		if (typeof l.text !== 'string' || !PRINTABLE.test(l.text)) {
			throw new BadRequest(`lines[${i}].text must be printable ASCII (0x20-0x7E)`);
		}
		const size = l.size === undefined ? 'normal' : l.size;
		if (typeof size !== 'string' || !SIZES.has(size)) {
			throw new BadRequest(`lines[${i}].size must be normal, tall or double`);
		}
		const max = size === 'double' ? Math.floor(target.width / 2) : target.width;
		if (l.text.length > max) {
			throw new BadRequest(
				`lines[${i}].text is ${l.text.length} characters; at most ${max} at this size on a ${target.width}-column printer`
			);
		}
		if (l.bold !== undefined && typeof l.bold !== 'boolean') {
			throw new BadRequest(`lines[${i}].bold must be a boolean`);
		}
		if (l.align !== undefined && (typeof l.align !== 'string' || !ALIGNS.has(l.align))) {
			throw new BadRequest(`lines[${i}].align must be left or center`);
		}
		const line: TextLine = { text: l.text };
		if (l.bold !== undefined) line.bold = l.bold;
		if (l.size !== undefined) line.size = size as TextLine['size'];
		if (l.align !== undefined) line.align = l.align as TextLine['align'];
		return line;
	});
	if (imageLines > MAX_IMAGE_LINES) {
		throw new BadRequest(`a job carries at most ${MAX_IMAGE_LINES} image lines`);
	}
	if (typeof body.cut !== 'boolean') throw new BadRequest('cut must be a boolean');
	return { id: jobId, printer, lines, cut: body.cut };
}

export function parseDrawerRequest(raw: unknown): DrawerRequest {
	const body = obj(raw, 'request');
	const requestId = id(body.id);
	if (
		typeof body.completedAt !== 'string' ||
		!ISO_WITH_OFFSET.test(body.completedAt) ||
		Number.isNaN(Date.parse(body.completedAt))
	) {
		throw new BadRequest('completedAt must be an ISO-8601 timestamp with an offset');
	}
	return { id: requestId, completedAt: body.completedAt };
}

// ── The server ──────────────────────────────────────────────────────────────

/** A request body up to MAX_BODY_BYTES — shared with the setup API (setup.ts). */
export function readBody(
	req: IncomingMessage
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on('data', (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				done = true;
				req.pause();
				resolve({ ok: false, reason: 'too_large' });
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (!done) resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
		});
		req.on('error', reject);
	});
}

function tokenMatches(header: string | undefined, token: string): boolean {
	if (!header || !header.startsWith('Bearer ')) return false;
	const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
	const expected = Buffer.from(token, 'utf8');
	// A length mismatch is a failure, not an exception: timingSafeEqual needs
	// equal lengths, so compare against the expected token's own length first.
	if (presented.length !== expected.length) return false;
	return timingSafeEqual(presented, expected);
}

/** A PUT /printers body the agent refuses, naming the field. */
export class BadPrinters extends Error {
	readonly field: string;
	constructor(field: string) {
		super(`bad printers: ${field}`);
		this.field = field;
	}
}

/**
 * The printers body of PUT /printers and of the setup page's POST
 * /setup/printers — ONE parser, so the two surfaces cannot disagree:
 * `{ receipt: { host, port?, width }, kitchen: { host, port?, width } | null }`,
 * port defaulting to 9100. Each printer is validated by config.ts parsePrinter,
 * the same rules the config file is read with. A receipt printer is required:
 * removing it is not offered. Only the three fields are copied.
 */
export function parsePrintersBody(raw: unknown): ReadyPrinters {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new BadPrinters('printers');
	}
	const body = raw as Record<string, unknown>;
	const one = (value: unknown, field: 'receipt' | 'kitchen') => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new BadPrinters(field);
		}
		const printer = value as Record<string, unknown>;
		// Only the known fields travel. A named printer (on this PC) carries no
		// host or port; a network one gets the ESC/POS default port.
		const shaped =
			printer.name !== undefined && printer.name !== null
				? { name: printer.name, host: printer.host, port: printer.port, width: printer.width }
				: { host: printer.host, port: printer.port ?? DEFAULT_PRINTER_PORT, width: printer.width };
		try {
			return parsePrinter(shaped, field);
		} catch (error) {
			// parsePrinter names the field: "config: receipt.host must be …".
			const named = /^config: (\S+) /.exec(error instanceof Error ? error.message : '');
			throw new BadPrinters(named?.[1] ?? field);
		}
	};
	const receipt = one(body.receipt, 'receipt');
	const kitchen =
		body.kitchen === null || body.kitchen === undefined ? null : one(body.kitchen, 'kitchen');
	return { receipt, kitchen };
}

type Send = (status: number, body: unknown, extra?: Record<string, string>) => void;

/** A JSON body under the shared rules: 415 unless JSON, 413 when too large; null after answering. */
async function jsonBody(req: IncomingMessage, send: Send): Promise<{ text: string } | null> {
	const type = req.headers['content-type'] ?? '';
	if (!/^application\/json\b/i.test(type)) {
		send(415, { error: 'unsupported_media_type' });
		return null;
	}
	const body = await readBody(req);
	if (!body.ok) {
		send(413, { error: 'payload_too_large' });
		return null;
	}
	return { text: body.text };
}

/**
 * `getConfig` is read ONCE per request and that snapshot judges the whole
 * request — the Origin wall, the CORS header and the token check — so a config
 * change made by the setup page mid-request cannot mix two configs.
 */
export function createAgentServer(getConfig: () => AgentConfig, deps: AgentDeps): Server {
	const server = createServer((req, res) => {
		const config = getConfig();
		const send: Send = (status, body, extra = {}) => {
			res.writeHead(status, {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				// Always the CONFIGURED origin, never echoed from the request.
				'Access-Control-Allow-Origin': config.origin,
				Vary: 'Origin',
				...extra
			});
			res.end(status === 204 ? undefined : JSON.stringify(body));
		};
		void handle(req, res, config, send).catch(() => {
			if (!res.headersSent) send(500, { error: 'internal' });
			else res.end();
		});
	});

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
		config: AgentConfig,
		send: Send
	): Promise<void> {
		const address = server.address();
		const boundPort = typeof address === 'object' && address ? address.port : config.port;
		const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);

		// 1. Host — a DNS-rebinding page reaches us with its own hostname.
		if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
			send(403, { error: 'bad_host' });
			return;
		}
		// 1b. The agent's own setup page (setup.ts): its own origin, its own walls.
		if (deps.setup && (await deps.setup(req, res, { boundPort, config }))) return;
		// 2. Origin — exactly the configured app, present and equal.
		if (req.headers.origin !== config.origin) {
			send(403, { error: 'bad_origin' });
			return;
		}
		// 3. Preflight — CORS headers, and Private Network Access for older Chrome.
		if (req.method === 'OPTIONS') {
			const extra: Record<string, string> = {
				'Access-Control-Allow-Methods': 'GET, POST, PUT',
				'Access-Control-Allow-Headers': 'authorization, content-type',
				'Access-Control-Max-Age': '600'
			};
			if (req.headers['access-control-request-private-network'] === 'true') {
				extra['Access-Control-Allow-Private-Network'] = 'true';
			}
			send(204, undefined, extra);
			return;
		}
		const path = (req.url ?? '/').split('?')[0];
		// 4. Pairing — before the token wall, because the caller does not have it yet.
		if (req.method === 'POST' && path === '/pair') {
			const claim = deps.claimPairing();
			if (claim === 'ok') send(200, { token: config.token });
			else send(403, { error: 'pairing_closed', reason: claim });
			return;
		}
		// 5. The pairing token, in constant time.
		if (!tokenMatches(req.headers.authorization, config.token)) {
			send(401, { error: 'unauthorized' });
			return;
		}

		if (req.method === 'GET' && path === '/status') {
			send(200, await deps.status());
			return;
		}
		// The printers plugged into this PC, for the till's Printer page to pick from.
		if (req.method === 'GET' && path === '/local-printers') {
			send(200, { printers: await deps.listLocalPrinters() });
			return;
		}
		// The till's Printer page sets the printers (tasks/print-agent-installer T-04).
		if (req.method === 'PUT' && path === '/printers') {
			const body = await jsonBody(req, send);
			if (!body) return;
			let raw: unknown;
			try {
				raw = JSON.parse(body.text);
			} catch {
				send(400, { error: 'bad_request', detail: 'body is not JSON' });
				return;
			}
			let printers: ReadyPrinters;
			try {
				printers = parsePrintersBody(raw);
			} catch (error) {
				if (error instanceof BadPrinters) {
					send(422, { error: 'bad_printers', field: error.field });
					return;
				}
				throw error;
			}
			const outcome = await deps.setPrinters(printers);
			if (!outcome.ok) {
				send(409, { error: 'jobs_waiting', target: outcome.target, queued: outcome.queued });
				return;
			}
			send(200, { printers: (await deps.status()).printers });
			return;
		}
		if (req.method === 'POST' && (path === '/jobs' || path === '/drawer')) {
			const body = await jsonBody(req, send);
			if (!body) return;
			let raw: unknown;
			try {
				raw = JSON.parse(body.text);
			} catch {
				send(422, {
					error: path === '/jobs' ? 'bad_job' : 'bad_request',
					detail: 'body is not JSON'
				});
				return;
			}
			try {
				if (path === '/jobs') {
					// A job is validated against the printer it targets; with no receipt
					// printer set yet there is nothing to print on.
					const receipt = config.printers.receipt;
					if (!receipt) {
						send(503, { error: 'no_printer' });
						return;
					}
					const printers = { receipt, kitchen: config.printers.kitchen };
					const outcome = await deps.submitJob(parseJob(raw, printers));
					if (outcome === 'no_printer') send(503, { error: 'no_printer' });
					else send(outcome === 'queued' ? 202 : 200, { status: outcome });
				} else {
					const outcome = await deps.pulseDrawer(parseDrawerRequest(raw));
					if (outcome === 'opened' || outcome === 'duplicate') send(200, { status: outcome });
					else if (outcome === 'too_late') send(409, { error: 'too_late' });
					else if (outcome === 'no_printer') send(503, { error: 'no_printer' });
					else send(503, { error: 'printer_unreachable' });
				}
			} catch (error) {
				if (error instanceof BadRequest) {
					send(422, {
						error: path === '/jobs' ? 'bad_job' : 'bad_request',
						detail: error.detail
					});
					return;
				}
				throw error;
			}
			return;
		}
		send(404, { error: 'not_found' });
	}

	return server;
}

/** Bind 127.0.0.1 ONLY — never 0.0.0.0, never :: — and resolve the bound port. */
export function listen(server: Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			const address = server.address();
			resolve(typeof address === 'object' && address ? address.port : port);
		});
	});
}
