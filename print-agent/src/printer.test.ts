import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrinterConfig } from './config.ts';
import { paperStatus, reachable, send } from './printer.ts';

type Fake = { cfg: PrinterConfig; received: Buffer[]; server: Server; close: () => Promise<void> };

const servers: Server[] = [];
afterEach(async () => {
	for (const s of servers.splice(0)) {
		s.emit('close');
		await new Promise((r) => s.close(() => r(undefined)));
	}
});

/**
 * A fake printer on 127.0.0.1:0 that collects bytes and optionally answers a
 * status query. Every accepted socket is tracked and destroyed on close, so a
 * connection the client never ends cannot hang the test's cleanup.
 */
function fakePrinter(answer?: (socket: Socket, data: Buffer) => void): Promise<Fake> {
	return new Promise((resolve) => {
		const received: Buffer[] = [];
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
			socket.on('data', (data: Buffer) => {
				received.push(data);
				answer?.(socket, data);
			});
		});
		server.on('close', () => {
			for (const s of sockets) s.destroy();
		});
		servers.push(server);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({
				cfg: { host: '127.0.0.1', port, width: 48 },
				received,
				server,
				close: () =>
					new Promise((r) => {
						for (const s of sockets) s.destroy();
						server.close(() => r(undefined));
					})
			});
		});
	});
}

async function closedPort(): Promise<PrinterConfig> {
	const fake = await fakePrinter();
	await fake.close();
	servers.splice(servers.indexOf(fake.server), 1);
	return fake.cfg;
}

describe('send', () => {
	it('delivers the exact bytes and resolves on close', async () => {
		const fake = await fakePrinter();
		const bytes = Uint8Array.of(0x1b, 0x40, 0x48, 0x69, 0x0a);
		await send(fake.cfg, bytes);
		await new Promise((r) => setTimeout(r, 20));
		expect(Array.from(Buffer.concat(fake.received))).toEqual(Array.from(bytes));
	});

	it('rejects when nothing listens', async () => {
		const cfg = await closedPort();
		await expect(send(cfg, Uint8Array.of(0x0a), 500)).rejects.toThrow();
	});

	it('rejects on timeout when the printer never closes its side', async () => {
		// The fake reads everything but never ends: allowHalfOpen keeps its side up
		// after the client's FIN, so only the client's timer can end the exchange.
		const held = new Set<Socket>();
		const server = createServer({ allowHalfOpen: true }, (socket) => {
			held.add(socket);
			socket.resume();
		});
		servers.push(server);
		server.on('close', () => {
			for (const s of held) s.destroy();
		});
		const port = await new Promise<number>((r) =>
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				r(typeof address === 'object' && address ? address.port : 0);
			})
		);
		await expect(
			send({ host: '127.0.0.1', port, width: 48 }, Uint8Array.of(0x0a), 150)
		).rejects.toThrow(/timed out/);
	});
});

describe('paperStatus', () => {
	it('is paper_out when the printer answers 0x72', async () => {
		const fake = await fakePrinter((socket) => socket.write(Uint8Array.of(0x72)));
		expect(await paperStatus(fake.cfg)).toBe('paper_out');
		expect(Array.from(fake.received[0] ?? [])).toEqual([0x10, 0x04, 0x04]);
	});

	it('is ok when the printer answers 0x12', async () => {
		const fake = await fakePrinter((socket) => socket.write(Uint8Array.of(0x12)));
		expect(await paperStatus(fake.cfg)).toBe('ok');
	});

	it('is unknown when the printer never answers, and when nothing listens', async () => {
		const silent = await fakePrinter();
		expect(await paperStatus(silent.cfg, 150)).toBe('unknown');
		const cfg = await closedPort();
		expect(await paperStatus(cfg, 300)).toBe('unknown');
	});
});

describe('reachable', () => {
	it('is true for a listening printer and false for a closed port', async () => {
		const fake = await fakePrinter();
		expect(await reachable(fake.cfg)).toBe(true);
		const cfg = await closedPort();
		expect(await reachable(cfg, 300)).toBe(false);
	});
});
