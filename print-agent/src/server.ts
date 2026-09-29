// THE PRINT AGENT'S HTTP SERVER (spec 11; tasks/menu-and-printing T-25).
//
// It binds 127.0.0.1 ONLY and answers exactly one origin: the till. Every
// request, preflighted or not, passes the same three walls IN THIS ORDER before
// any route runs — Host (defeats DNS rebinding), Origin (only the configured app
// may talk to it; a request with no Origin is refused too), then the Bearer
// token compared in constant time. CORS headers alone protect nothing: a page
// can send a "simple" request with no preflight, so the checks are on every
// request and the token is never echoed or logged.
//
// The agent is the one program on the till PC that can open the cash drawer,
// which is why the drawer is its own endpoint (T-26 never queues or replays it)
// and why a job's text is validated here to printable ASCII within the target
// printer's width — the encoder (T-26) is the second wall.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentConfig } from './config.ts';

export type PrintLine = {
	text: string;
	bold?: boolean;
	size?: 'normal' | 'tall' | 'double';
	align?: 'left' | 'center';
};
export type Job = { id: string; printer: 'receipt' | 'kitchen'; lines: PrintLine[]; cut: boolean };
export type DrawerRequest = { id: string; completedAt: string };
export type PrinterStatus = { width: 32 | 48; reachable: boolean; queued: number };
export type AgentStatus = {
	agentVersion: 1;
	printers: { receipt: PrinterStatus; kitchen: PrinterStatus | null };
};
export type SubmitOutcome = 'queued' | 'duplicate';
export type DrawerOutcome = 'opened' | 'duplicate' | 'too_late' | 'printer_unreachable';

export type AgentDeps = {
	submitJob: (job: Job) => SubmitOutcome | Promise<SubmitOutcome>;
	pulseDrawer: (request: DrawerRequest) => Promise<DrawerOutcome>;
	status: () => Promise<AgentStatus>;
};

export const MAX_BODY_BYTES = 65_536;
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
 * A print job as the till sends it. The target printer decides the width: a
 * kitchen job goes to the kitchen printer, or to the receipt printer when none
 * is configured (assumption 7). A 'double' line holds half the columns.
 */
export function parseJob(raw: unknown, printers: AgentConfig['printers']): Job {
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
	const lines: PrintLine[] = body.lines.map((entry, i) => {
		const l = obj(entry, `lines[${i}]`);
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
		const line: PrintLine = { text: l.text };
		if (l.bold !== undefined) line.bold = l.bold;
		if (l.size !== undefined) line.size = size as PrintLine['size'];
		if (l.align !== undefined) line.align = l.align as PrintLine['align'];
		return line;
	});
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
		// 4. The pairing token, in constant time.
		if (!tokenMatches(req.headers.authorization, config.token)) {
			send(res, 401, { error: 'unauthorized' });
			return;
		}

		const path = (req.url ?? '/').split('?')[0];
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
					const outcome = await deps.submitJob(parseJob(raw, config.printers));
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
