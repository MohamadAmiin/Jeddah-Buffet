// THE NETWORK PRINTER (spec 11; tasks/menu-and-printing T-26).
//
// Raw ESC/POS over TCP (port 9100 by convention): open a socket, write the
// bytes, half-close, and treat a clean close as delivery. There is no
// acknowledgement protocol in raw printing, so "delivered" means the printer
// accepted the bytes; the queue (queue.ts) is what makes a failure safe to
// retry. The paper-sensor query is best effort — many printers never answer
// it, and an unanswered query prints anyway.
import { connect, type Socket } from 'node:net';
import type { PrinterConfig } from './config.ts';
import { PAPER_STATUS_QUERY } from './escpos.ts';

export type PaperStatus = 'ok' | 'paper_out' | 'unknown';

function open(cfg: PrinterConfig, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: cfg.host, port: cfg.port });
		const timer = setTimeout(() => {
			socket.destroy(new Error(`printer ${cfg.host}:${cfg.port}: connect timed out`));
		}, timeoutMs);
		socket.once('connect', () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** Write the bytes and half-close; resolves on a clean close, rejects on error or timeout. */
export function send(cfg: PrinterConfig, bytes: Uint8Array, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const socket = connect({ host: cfg.host, port: cfg.port });
		const timer = setTimeout(() => {
			socket.destroy();
			finish(new Error(`printer ${cfg.host}:${cfg.port}: timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		socket.once('connect', () => {
			socket.end(bytes);
		});
		socket.once('error', (error) => finish(error));
		socket.once('close', (hadError) => {
			finish(
				hadError ? new Error(`printer ${cfg.host}:${cfg.port}: connection failed`) : undefined
			);
		});
	});
}

/**
 * DLE EOT 4 — read one status byte. Bits 5 and 6 both set (0x60) mean the
 * paper roll has ended; any other byte is ok; no byte in time is unknown.
 */
export function paperStatus(cfg: PrinterConfig, timeoutMs = 1000): Promise<PaperStatus> {
	return new Promise((resolve) => {
		let settled = false;
		let socket: Socket | undefined;
		const finish = (status: PaperStatus) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			resolve(status);
		};
		const timer = setTimeout(() => finish('unknown'), timeoutMs);
		open(cfg, timeoutMs)
			.then((s) => {
				socket = s;
				if (settled) {
					s.destroy();
					return;
				}
				s.once('data', (chunk: Buffer) => {
					const byte = chunk[0];
					if (byte === undefined) finish('unknown');
					else finish((byte & 0x60) === 0x60 ? 'paper_out' : 'ok');
				});
				s.once('error', () => finish('unknown'));
				s.once('close', () => finish('unknown'));
				s.write(PAPER_STATUS_QUERY);
			})
			.catch(() => finish('unknown'));
	});
}

/** Can a TCP connection be opened at all? */
export async function reachable(cfg: PrinterConfig, timeoutMs = 1000): Promise<boolean> {
	try {
		const socket = await open(cfg, timeoutMs);
		socket.destroy();
		return true;
	} catch {
		return false;
	}
}
