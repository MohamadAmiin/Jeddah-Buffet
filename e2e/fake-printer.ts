// A FAKE NETWORK PRINTER for e2e/printing.spec.ts (menu-and-printing T-32): a
// raw TCP listener on 127.0.0.1 that keeps every byte it receives and answers
// the ESC/POS paper-status query 10 04 04 with 0x12 (paper present). It stands
// where a real ESC/POS printer's port 9100 would: the print agent under test is
// the REAL one, spawned as its own process. Not a spec — Playwright never
// collects a file named like this.
import { createServer, type Socket } from 'node:net';

export type FakePrinter = {
	port: number;
	/** Everything received so far, in arrival order (status queries excluded). */
	bytes(): Buffer;
	/** How many times `needle` occurs in the received bytes (non-overlapping). */
	count(needle: Buffer | string): number;
	/** How many separate connections carried printable bytes — one per job or pulse. */
	tapes(): number;
	/** Wait until `bytes()` contains `needle` at or after `from`, or throw after `timeoutMs`. */
	waitFor(needle: Buffer | string, options?: { from?: number; timeoutMs?: number }): Promise<void>;
	close(): Promise<void>;
};

const STATUS_QUERY = Buffer.from([0x10, 0x04, 0x04]);
const asBuffer = (needle: Buffer | string) =>
	typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle;

export function startFakePrinter(): Promise<FakePrinter> {
	return new Promise((resolve) => {
		const received: Buffer[] = [];
		let tapeCount = 0;
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			let printable = false;
			socket.on('data', (chunk: Buffer) => {
				if (chunk.equals(STATUS_QUERY)) {
					socket.write(Buffer.from([0x12]));
					return;
				}
				printable = true;
				received.push(chunk);
			});
			socket.on('close', () => {
				sockets.delete(socket);
				if (printable) tapeCount += 1;
			});
			socket.on('error', () => {});
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			const bytes = () => Buffer.concat(received);
			resolve({
				port,
				bytes,
				tapes: () => tapeCount,
				count: (needle) => {
					const target = asBuffer(needle);
					const all = bytes();
					let n = 0;
					let at = all.indexOf(target);
					while (at !== -1) {
						n += 1;
						at = all.indexOf(target, at + target.length);
					}
					return n;
				},
				waitFor: async (needle, options = {}) => {
					const target = asBuffer(needle);
					const from = options.from ?? 0;
					const timeoutMs = options.timeoutMs ?? 10_000;
					const start = Date.now();
					while (bytes().indexOf(target, from) === -1) {
						if (Date.now() - start > timeoutMs) {
							throw new Error(
								`fake printer on ${port}: "${target.toString('latin1')}" never arrived after byte ${from}; holds ${bytes().length} bytes`
							);
						}
						await new Promise((r) => setTimeout(r, 100));
					}
				},
				close: () =>
					new Promise((r) => {
						for (const s of sockets) s.destroy();
						server.close(() => r(undefined));
					})
			});
		});
	});
}
