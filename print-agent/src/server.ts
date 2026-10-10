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
// place the token is ever sent.
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
import type { AgentConfig, ReadyPrinters } from './config.ts';
import { DOTS, MAX_IMAGE_HEIGHT_DOTS } from './escpos.ts';
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
export const AGENT_FEATURES = ['printers', 'setup'] as const;
/** `host`/`port` let the till bind a logo confirmation to ONE printer (T-14). */
export type PrinterStatus = {
	host: string;
	port: number;
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
	/** Take open pairing's one claim (pairing.ts claimPairing). */
	claimPairing: () => PairingClaim;
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

function readBody(
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

export function createAgentServer(config: AgentConfig, deps: AgentDeps): Server {
	const server = createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (!res.headersSent) send(res, 500, { error: 'internal' });
			else res.end();
		});
	});

	function send(
		res: ServerResponse,
		status: number,
		body: unknown,
		extra: Record<string, string> = {}
	) {
		res.writeHead(status, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'Access-Control-Allow-Origin': config.origin,
			Vary: 'Origin',
			...extra
		});
		res.end(status === 204 ? undefined : JSON.stringify(body));
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const address = server.address();
		const boundPort = typeof address === 'object' && address ? address.port : config.port;
		const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);

		// 1. Host — a DNS-rebinding page reaches us with its own hostname.
		if (!req.headers.host || !allowedHosts.has(req.headers.host)) {
			send(res, 403, { error: 'bad_host' });
			return;
		}
		// 2. Origin — exactly the configured app, present and equal.
		if (req.headers.origin !== config.origin) {
			send(res, 403, { error: 'bad_origin' });
			return;
		}
		// 3. Preflight — CORS headers, and Private Network Access for older Chrome.
		if (req.method === 'OPTIONS') {
			const extra: Record<string, string> = {
				'Access-Control-Allow-Methods': 'GET, POST',
				'Access-Control-Allow-Headers': 'authorization, content-type',
				'Access-Control-Max-Age': '600'
			};
			if (req.headers['access-control-request-private-network'] === 'true') {
				extra['Access-Control-Allow-Private-Network'] = 'true';
			}
			send(res, 204, undefined, extra);
			return;
		}
		const path = (req.url ?? '/').split('?')[0];
		// 4. Pairing — before the token wall, because the caller does not have it yet.
		if (req.method === 'POST' && path === '/pair') {
			const claim = deps.claimPairing();
			if (claim === 'ok') send(res, 200, { token: config.token });
			else send(res, 403, { error: 'pairing_closed', reason: claim });
			return;
		}
		// 5. The pairing token, in constant time.
		if (!tokenMatches(req.headers.authorization, config.token)) {
			send(res, 401, { error: 'unauthorized' });
			return;
		}

		if (req.method === 'GET' && path === '/status') {
			send(res, 200, await deps.status());
			return;
		}
		if (req.method === 'POST' && (path === '/jobs' || path === '/drawer')) {
			const type = req.headers['content-type'] ?? '';
			if (!/^application\/json\b/i.test(type)) {
				send(res, 415, { error: 'unsupported_media_type' });
				return;
			}
			const body = await readBody(req);
			if (!body.ok) {
				send(res, 413, { error: 'payload_too_large' });
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(body.text);
			} catch {
				send(res, 422, {
					error: path === '/jobs' ? 'bad_job' : 'bad_request',
					detail: 'body is not JSON'
				});
				return;
			}
			try {
				if (path === '/jobs') {
					// A job is validated against the printer it targets; with no receipt
					// printer set yet there is nothing to print on (tasks/print-agent-installer).
					const receipt = config.printers.receipt;
					if (!receipt) {
						send(res, 503, { error: 'no_printer' });
						return;
					}
					const printers = { receipt, kitchen: config.printers.kitchen };
					const outcome = await deps.submitJob(parseJob(raw, printers));
					send(res, outcome === 'queued' ? 202 : 200, { status: outcome });
				} else {
					const outcome = await deps.pulseDrawer(parseDrawerRequest(raw));
					if (outcome === 'opened' || outcome === 'duplicate') send(res, 200, { status: outcome });
					else if (outcome === 'too_late') send(res, 409, { error: 'too_late' });
					else send(res, 503, { error: 'printer_unreachable' });
				}
			} catch (error) {
				if (error instanceof BadRequest) {
					send(res, 422, {
						error: path === '/jobs' ? 'bad_job' : 'bad_request',
						detail: error.detail
					});
					return;
				}
				throw error;
			}
			return;
		}
		send(res, 404, { error: 'not_found' });
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
