// THE AGENT'S OWN SETUP PAGE AND ITS API (tasks/print-agent-installer T-05).
//
// The installer opens http://127.0.0.1:<port>/setup#s=<setup key> in the PC's
// browser. The page (setup-page.ts) shows what the agent answers and lets the
// owner set the printers, print a test page and re-open pairing, without the
// till. It is a SECOND door to the agent, so it has walls of its own, in order:
//
//   1. Host — checked by server.ts before this runs (DNS rebinding).
//   2. Origin present and equal to THIS agent's own loopback origin. The app's
//      origin is refused here: the till talks to the agent through /pair,
//      /status, /jobs, /drawer and /printers, never through the setup page.
//   3. Sec-Fetch-Site, when the browser sends it, must be same-origin.
//   4. A JSON body under the size cap.
//   5. The setup key, which only the installer's console and the URL fragment
//      it opened ever carried, compared in constant time.
//
// The API is ALL POST, because a browser sends no Origin on a same-origin GET
// and a GET could not be walled. No response carries CORS headers, so a page on
// another origin can neither send the X-Setup-Secret header (its preflight
// fails) nor read an answer. The static page carries no secret at all.
//
// Nothing here opens the cash drawer. The test print is text only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseOrigin, type AgentConfig } from './config.ts';
import type { PairingStatus } from './pairing.ts';
import { bakedBuild, isPackaged } from './paths.ts';
import type { Runtime } from './runtime.ts';
import {
	BadPrinters,
	parsePrintersBody,
	readBody,
	type AgentDeps,
	type TextLine
} from './server.ts';

export type SetupDeps = {
	runtime: Pick<Runtime, 'deps' | 'setOrigin'>;
	openPairing: () => void;
	pairingState: () => PairingStatus;
	/** A new pairing token, saved, and pairing opened: every till must pair again. */
	rekey: () => Promise<void>;
	/** The graceful shutdown: the queue closes, then the process exits 0. */
	quit: () => void;
	page: { html: string; js: string; css: string };
};

const STATIC_HEADERS = {
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'no-referrer',
	'Content-Security-Policy':
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

/** The test page's lines: text only, each at most `width` printable ASCII characters. */
export function setupTestLines(width: 32 | 48, now: Date = new Date()): TextLine[] {
	const two = (n: number) => String(n).padStart(2, '0');
	// Built from the clock's numbers, not toLocaleString, which can emit non-ASCII spaces.
	const at =
		`${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
		`${two(now.getHours())}:${two(now.getMinutes())}`;
	return [
		{ text: 'matcami print agent', bold: true, align: 'center' },
		{ text: 'Test page', align: 'center' },
		{ text: '1234567890'.repeat(5).slice(0, width) },
		{ text: width === 32 ? 'Paper: 58 mm (32)' : 'Paper: 80 mm (48)' },
		{ text: at }
	];
}

function sameSecret(presented: string | string[] | undefined, expected: string): boolean {
	if (typeof presented !== 'string') return false;
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	// timingSafeEqual needs equal lengths; a length mismatch is simply a failure.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** The setup page and its API, as the `setup` dependency server.ts dispatches to after its Host wall. */
export function createSetupHandler(deps: SetupDeps): NonNullable<AgentDeps['setup']> {
	return async (req, res, { boundPort, config }) => {
		const path = (req.url ?? '/').split('?')[0] ?? '/';
		if (
			path !== '/setup' &&
			path !== '/setup.js' &&
			path !== '/setup.css' &&
			!path.startsWith('/setup/')
		) {
			return false;
		}
		const json = (status: number, body: unknown) => {
			res.writeHead(status, {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			});
			res.end(JSON.stringify(body));
		};

		// ── The page itself: no secret in it, no CORS. ──
		if (!path.startsWith('/setup/')) {
			if (req.method !== 'GET') {
				json(405, { error: 'method_not_allowed' });
				return true;
			}
			const [type, body] =
				path === '/setup'
					? ['text/html; charset=utf-8', deps.page.html]
					: path === '/setup.js'
						? ['text/javascript; charset=utf-8', deps.page.js]
						: ['text/css; charset=utf-8', deps.page.css];
			res.writeHead(200, { 'Content-Type': type, ...STATIC_HEADERS });
			res.end(body);
			return true;
		}

		// ── The API: every wall, in order. ──
		if (req.method !== 'POST') {
			json(405, { error: 'method_not_allowed' });
			return true;
		}
		const own = new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
		if (typeof req.headers.origin !== 'string' || !own.has(req.headers.origin)) {
			json(403, { error: 'bad_origin' });
			return true;
		}
		const site = req.headers['sec-fetch-site'];
		if (site !== undefined && site !== 'same-origin') {
			json(403, { error: 'cross_site' });
			return true;
		}
		if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
			json(415, { error: 'unsupported_media_type' });
			return true;
		}
		const read = await readBody(req);
		if (!read.ok) {
			json(413, { error: 'payload_too_large' });
			return true;
		}
		if (config.setupSecret === null) {
			json(403, { error: 'setup_disabled' });
			return true;
		}
		if (!sameSecret(req.headers['x-setup-secret'], config.setupSecret)) {
			json(401, { error: 'unauthorized' });
			return true;
		}
		let body: Record<string, unknown> = {};
		if (read.text.trim() !== '') {
			let raw: unknown;
			try {
				raw = JSON.parse(read.text);
			} catch {
				json(400, { error: 'bad_request', detail: 'body is not JSON' });
				return true;
			}
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
				json(400, { error: 'bad_request', detail: 'body must be an object' });
				return true;
			}
			body = raw as Record<string, unknown>;
		}

		await route(path, body, config, json);
		return true;
	};

	async function route(
		path: string,
		body: Record<string, unknown>,
		config: AgentConfig,
		json: (status: number, body: unknown) => void
	): Promise<void> {
		const { runtime } = deps;
		if (path === '/setup/state') {
			// Never the token, never the setup key.
			json(200, {
				agentVersion: 2,
				packaged: isPackaged(),
				builtAt: bakedBuild()?.builtAt ?? null,
				origin: config.origin,
				pairing: deps.pairingState(),
				printers: (await runtime.deps.status()).printers
			});
			return;
		}
		if (path === '/setup/printers') {
			let printers;
			try {
				printers = parsePrintersBody(body);
			} catch (error) {
				if (error instanceof BadPrinters) {
					json(422, { error: 'bad_printers', field: error.field });
					return;
				}
				throw error;
			}
			const outcome = await runtime.deps.setPrinters(printers);
			if (!outcome.ok) {
				json(409, { error: 'jobs_waiting', target: outcome.target, queued: outcome.queued });
				return;
			}
			json(200, { printers: (await runtime.deps.status()).printers });
			return;
		}
		if (path === '/setup/origin') {
			if (body.confirm !== true) {
				json(422, { error: 'confirm_required' });
				return;
			}
			let origin: string;
			try {
				origin = parseOrigin(body.origin);
			} catch {
				json(422, { error: 'bad_origin_value' });
				return;
			}
			await runtime.setOrigin(origin);
			// Tills paired under the old origin now answer bad_origin; the new one must pair.
			deps.openPairing();
			json(200, { origin });
			return;
		}
		if (path === '/setup/pairing') {
			deps.openPairing();
			json(200, { pairing: 'open' });
			return;
		}
		if (path === '/setup/rekey') {
			if (body.confirm !== true) {
				json(422, { error: 'confirm_required' });
				return;
			}
			await deps.rekey();
			json(200, { pairing: 'open' });
			return;
		}
		if (path === '/setup/test-print') {
			const receipt = config.printers.receipt;
			if (!receipt) {
				json(503, { error: 'no_printer' });
				return;
			}
			const result = await runtime.deps.submitJob({
				id: 'setup-' + randomBytes(8).toString('hex'),
				printer: 'receipt',
				lines: setupTestLines(receipt.width),
				cut: true
			});
			if (result === 'no_printer') json(503, { error: 'no_printer' });
			else json(202, { result });
			return;
		}
		if (path === '/setup/quit') {
			json(200, { quitting: true });
			// After the answer is on its way: the caller (the installer) waits for the port to close.
			setImmediate(() => deps.quit());
			return;
		}
		json(404, { error: 'not_found' });
	}
}
