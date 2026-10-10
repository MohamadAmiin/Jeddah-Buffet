import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalPrinter } from './config.ts';
import { DRAWER_PULSE } from './escpos.ts';
import {
	forgetLocalPrinters,
	helperEnv,
	listLocalPrinters,
	localIo,
	localQueued,
	localReachable,
	parseGetPrinter,
	parseLpstat,
	parseRequestId,
	powershellArgs,
	PS_LIST,
	PS_SEND,
	PS_STATUS,
	sendLocalNow,
	spoolLocal,
	type ExecOpts,
	type ExecOutcome
} from './local-printer.ts';
import { createDrawer, createQueue, type Queue } from './queue.ts';

type Call = { cmd: string; args: string[]; opts: ExecOpts };

const SOMSTAR: LocalPrinter = { name: 'SomStar-80mm-Series', width: 48 };
const ok = (stdout = ''): ExecOutcome => ({ status: 0, stdout, stderr: '' });

/** `lpstat -p`, C locale, as a Linux Mint 22.3 PC printed it on 2026-10-10. */
const LPSTAT_P = `printer SomStar-80mm-Series is idle.  enabled since Sat Oct 10 15:54:12 2026
printer Office-Laser now printing Office-Laser-12.  enabled since Sat Oct 10 15:00:00 2026
printer Old-Epson disabled since Sat Oct 10 16:00:51 2026 -
	Unplugged or turned off
printer Flaky is idle.  enabled since Sat Oct 10 16:02:38 2026
	Waiting for printer to become available.
`;

const realExec = localIo.exec;
const realPlatform = localIo.platform;
let calls: Call[] = [];
/** Answers by command; a command with no answer is a failure, never a real spawn. */
let answer: (call: Call) => ExecOutcome | undefined = () => undefined;

beforeEach(() => {
	calls = [];
	answer = () => undefined;
	forgetLocalPrinters();
	localIo.platform = () => 'linux';
	localIo.exec = async (cmd, args, opts) => {
		const call = { cmd, args, opts };
		calls.push(call);
		return answer(call) ?? { status: 127, stdout: '', stderr: `${cmd}: not faked` };
	};
});
afterEach(() => {
	localIo.exec = realExec;
	localIo.platform = realPlatform;
	forgetLocalPrinters();
});

describe('reading the print service (CUPS)', () => {
	it('parses lpstat -p: idle, printing, disabled, and an enabled printer the backend is waiting for', () => {
		expect(parseLpstat(LPSTAT_P)).toEqual([
			{ name: 'SomStar-80mm-Series', state: 'idle' },
			{ name: 'Office-Laser', state: 'printing' },
			{ name: 'Old-Epson', state: 'stopped' },
			{ name: 'Flaky', state: 'stopped' }
		]);
		expect(parseLpstat('')).toEqual([]);
	});

	it('parses the lp request id', () => {
		expect(parseRequestId('request id is SomStar-80mm-Series-47 (0 file(s))\n')).toBe(
			'SomStar-80mm-Series-47'
		);
		expect(parseRequestId('lp: The printer or class does not exist.')).toBeNull();
	});

	it('lists printers with lpstat -p in a C locale, caches the list, and lists nothing on a PC with no printer', async () => {
		answer = (c) => (c.cmd === 'lpstat' && c.args[0] === '-p' ? ok(LPSTAT_P) : undefined);
		const first = await listLocalPrinters();
		expect(first.map((p) => p.name)).toEqual([
			'SomStar-80mm-Series',
			'Office-Laser',
			'Old-Epson',
			'Flaky'
		]);
		await listLocalPrinters();
		expect(calls).toHaveLength(1);
		forgetLocalPrinters();
		answer = () => ({ status: 1, stdout: '', stderr: 'lpstat: No destinations added.' });
		expect(await listLocalPrinters()).toEqual([]);
	});

	it('a printer is reachable while the service calls it idle or printing — not stopped, not missing', async () => {
		answer = (c) => (c.cmd === 'lpstat' ? ok(LPSTAT_P) : undefined);
		expect(await localReachable(SOMSTAR)).toBe(true);
		expect(await localReachable({ name: 'Office-Laser', width: 32 })).toBe(true);
		expect(await localReachable({ name: 'Old-Epson', width: 32 })).toBe(false);
		expect(await localReachable({ name: 'Flaky', width: 32 })).toBe(false);
		expect(await localReachable({ name: 'Nope', width: 32 })).toBe(false);
	});

	it('counts the jobs the service still holds for one printer', async () => {
		answer = (c) =>
			c.cmd === 'lpstat' && c.args[0] === '-o'
				? ok(
						'SomStar-80mm-Series-47  mohamed-amiin     1024   Sat Oct 10 16:01:05 2026\nSomStar-80mm-Series-48  mohamed-amiin     1024   Sat Oct 10 16:01:09 2026\n'
					)
				: undefined;
		expect(await localQueued(SOMSTAR)).toBe(2);
		expect(calls[0]).toMatchObject({ cmd: 'lpstat', args: ['-o', 'SomStar-80mm-Series'] });
		answer = () => ({ status: 1, stdout: '', stderr: '' });
		expect(await localQueued(SOMSTAR)).toBe(0);
	});
});

describe('sending through the service (CUPS)', () => {
	const bytes = Uint8Array.from([0x1b, 0x40, 0x41, 0x0a]);

	it('spoolLocal hands the raw bytes to lp -d <name> -o raw on stdin and returns the job id', async () => {
		answer = (c) =>
			c.cmd === 'lp' ? ok('request id is SomStar-80mm-Series-50 (0 file(s))\n') : undefined;
		expect(await spoolLocal(SOMSTAR, bytes, 5000)).toBe('SomStar-80mm-Series-50');
		expect(calls[0]!.cmd).toBe('lp');
		expect(calls[0]!.args).toEqual(['-d', 'SomStar-80mm-Series', '-o', 'raw']);
		expect(Buffer.from(calls[0]!.opts.stdin!)).toEqual(Buffer.from(bytes));
	});

	it('spoolLocal rejects when lp refuses (no such printer, the service down)', async () => {
		answer = () => ({ status: 1, stdout: '', stderr: 'lp: The printer or class does not exist.' });
		await expect(spoolLocal(SOMSTAR, bytes, 5000)).rejects.toThrow(/does not exist/);
	});

	it('sendLocalNow resolves once the job has left the service queue', async () => {
		let polls = 0;
		answer = (c) => {
			if (c.cmd === 'lp') return ok('request id is SomStar-80mm-Series-51 (0 file(s))\n');
			if (c.cmd === 'lpstat') {
				polls += 1;
				return ok(
					polls < 3 ? 'SomStar-80mm-Series-51  mohamed-amiin  5  Sat Oct 10 16:05:00 2026\n' : ''
				);
			}
			return undefined;
		};
		await sendLocalNow(SOMSTAR, bytes, 3000);
		expect(polls).toBe(3);
		expect(calls.some((c) => c.cmd === 'cancel')).toBe(false);
	});

	it('THE DRAWER RULE: a failed or hung lpstat never counts as "printed" — the job is cancelled at the deadline', async () => {
		for (const broken of [
			{ status: 1, stdout: '', stderr: 'lpstat: Bad file descriptor' },
			{ status: -1, stdout: '', stderr: 'lpstat timed out after 5000 ms' }
		]) {
			calls = [];
			answer = (c) => {
				if (c.cmd === 'lp') return ok('request id is SomStar-80mm-Series-53 (0 file(s))\n');
				if (c.cmd === 'lpstat') return broken;
				if (c.cmd === 'cancel') return ok();
				return undefined;
			};
			await expect(sendLocalNow(SOMSTAR, bytes, 400)).rejects.toThrow(/cancelled/);
			expect(calls.find((c) => c.cmd === 'cancel')?.args).toEqual(['SomStar-80mm-Series-53']);
		}
	});

	it('THE DRAWER RULE: a job still waiting at the timeout is CANCELLED and the send fails', async () => {
		answer = (c) => {
			if (c.cmd === 'lp') return ok('request id is SomStar-80mm-Series-52 (0 file(s))\n');
			if (c.cmd === 'lpstat')
				return ok('SomStar-80mm-Series-52  mohamed-amiin  5  Sat Oct 10 16:05:00 2026\n');
			if (c.cmd === 'cancel') return ok();
			return undefined;
		};
		await expect(sendLocalNow(SOMSTAR, bytes, 400)).rejects.toThrow(/cancelled/);
		const cancel = calls.find((c) => c.cmd === 'cancel');
		expect(cancel?.args).toEqual(['SomStar-80mm-Series-52']);
	});
});

describe('the Windows spooler helpers', () => {
	beforeEach(() => {
		localIo.platform = () => 'win32';
	});

	it('run PowerShell with the script base64-encoded and the printer name in the environment, never in the script', () => {
		const args = powershellArgs(PS_SEND);
		expect(args.slice(0, 5)).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand'
		]);
		expect(Buffer.from(args[5]!, 'base64').toString('utf16le')).toBe(PS_SEND);
		for (const script of [PS_LIST, PS_STATUS, PS_SEND]) {
			expect(script).not.toMatch(/\$\{/);
		}
		expect(PS_SEND).toContain('winspool.drv');
		expect(PS_SEND).toContain('"RAW"');
		expect(PS_SEND).toContain('Remove-PrintJob');
		expect(PS_SEND).toContain('$env:MATCAMI_PRINTER');
		expect(helperEnv({ name: 'POS58 "Front"', width: 32 }, 3000)).toEqual({
			MATCAMI_PRINTER: 'POS58 "Front"',
			MATCAMI_WAIT_MS: '3000'
		});
	});

	it('lists printers from Get-Printer lines: Normal and Printing can print, the rest cannot', async () => {
		answer = (c) =>
			c.cmd === 'powershell'
				? ok('POS-80\tNormal\r\nKitchen\tPrinting\r\nOffice\tOffline\r\n')
				: undefined;
		expect(await listLocalPrinters()).toEqual([
			{ name: 'POS-80', state: 'idle' },
			{ name: 'Kitchen', state: 'printing' },
			{ name: 'Office', state: 'stopped' }
		]);
		expect(parseGetPrinter('Microsoft Print to PDF\tNormal')).toEqual([
			{ name: 'Microsoft Print to PDF', state: 'idle' }
		]);
	});

	it('the drawer opens on "printed <job>" with exit 0, and the spooler job count is read from the status helper', async () => {
		answer = (c) =>
			c.cmd === 'powershell'
				? c.opts.env?.MATCAMI_WAIT_MS === '3000'
					? ok('printed 13\r\n')
					: ok('Normal\t2\r\n')
				: undefined;
		const printer: LocalPrinter = { name: 'POS-80', width: 48 };
		await expect(sendLocalNow(printer, DRAWER_PULSE, 3000)).resolves.toBeUndefined();
		expect(await localQueued(printer)).toBe(2);
		answer = (c) => (c.cmd === 'powershell' ? ok('') : undefined);
		expect(await localQueued(printer)).toBe(0);
		// A job the spooler no longer lists is printed; a failed query is not.
		expect(PS_SEND).toContain("Category -eq 'ObjectNotFound'");
		expect(PS_SEND).toContain('-ErrorAction Stop');
	});

	it('spools and reads the job id; a helper that cancelled the job (exit 3) fails the drawer send', async () => {
		answer = (c) =>
			c.cmd === 'powershell'
				? c.opts.env?.MATCAMI_WAIT_MS === '0'
					? ok('spooled 12\r\n')
					: { status: 3, stdout: 'cancelled 13\r\n', stderr: '' }
				: undefined;
		const printer: LocalPrinter = { name: 'POS-80', width: 48 };
		expect(await spoolLocal(printer, Uint8Array.of(1), 5000)).toBe('12');
		expect(calls[0]!.opts.env).toEqual({ MATCAMI_PRINTER: 'POS-80', MATCAMI_WAIT_MS: '0' });
		await expect(sendLocalNow(printer, DRAWER_PULSE, 3000)).rejects.toThrow(/cancelled/);
		expect(calls[1]!.opts.env).toEqual({ MATCAMI_PRINTER: 'POS-80', MATCAMI_WAIT_MS: '3000' });
	});
});

// ── The queue and the drawer, on a printer this PC knows ────────────────────

describe('a receipt printer on this PC, through the queue and the drawer', () => {
	const queues: Queue[] = [];
	const dirs: string[] = [];
	afterEach(async () => {
		for (const q of queues.splice(0)) await q.close();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const tmp = () => {
		const dir = mkdtempSync(join(tmpdir(), 'matcami-local-queue-'));
		dirs.push(dir);
		return dir;
	};
	const until = async (cond: () => boolean, what: string) => {
		const start = Date.now();
		while (!cond()) {
			if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}`);
			await new Promise((r) => setTimeout(r, 15));
		}
	};

	it('a receipt goes to lp as raw ESC/POS; /status names the printer and counts what the service holds', async () => {
		answer = (c) => {
			if (c.cmd === 'lp') return ok('request id is SomStar-80mm-Series-60 (0 file(s))\n');
			if (c.cmd === 'lpstat' && c.args[0] === '-p') return ok(LPSTAT_P);
			if (c.cmd === 'lpstat' && c.args[0] === '-o')
				return ok('SomStar-80mm-Series-60  x  5  now\n');
			return undefined;
		};
		const q = createQueue({
			dataDir: tmp(),
			printers: { receipt: SOMSTAR, kitchen: null },
			retry: { baseMs: 40, maxMs: 160 },
			paperStatusTimeoutMs: 40,
			sendTimeoutMs: 1000
		});
		queues.push(q);
		expect(q.submit({ id: 'r1', printer: 'receipt', lines: [{ text: 'Tea' }], cut: true })).toBe(
			'queued'
		);
		await until(() => calls.some((c) => c.cmd === 'lp'), 'the lp call');
		const lp = calls.find((c) => c.cmd === 'lp')!;
		expect(lp.args).toEqual(['-d', 'SomStar-80mm-Series', '-o', 'raw']);
		expect(Buffer.from(lp.opts.stdin!).toString('latin1')).toContain('Tea');
		await until(() => q.queuedByTarget().receipt === 0, 'the queue to drain');
		const status = await q.status();
		expect(status.printers.receipt).toEqual({
			name: 'SomStar-80mm-Series',
			width: 48,
			reachable: true,
			queued: 1
		});
		expect(status.printers.receipt).not.toHaveProperty('host');
	});

	it('a job that carries the logo is bound to the named printer on disk, by its label', async () => {
		answer = () => ({ status: 1, stdout: '', stderr: 'lp: The printer or class does not exist.' });
		const dir = tmp();
		const q = createQueue({
			dataDir: dir,
			printers: { receipt: SOMSTAR, kitchen: null },
			retry: { baseMs: 40, maxMs: 160 },
			paperStatusTimeoutMs: 40,
			sendTimeoutMs: 1000
		});
		queues.push(q);
		expect(
			q.submit({
				id: 'img1',
				printer: 'receipt',
				lines: [{ image: { widthDots: 8, heightDots: 1, bitmap: 'AA==' } }],
				cut: true
			})
		).toBe('queued');
		const [file] = readdirSync(join(dir, 'queue')).filter((n) => n.endsWith('.json'));
		const queued = JSON.parse(readFileSync(join(dir, 'queue', file!), 'utf8')) as {
			imagePrinter?: string;
		};
		expect(queued.imagePrinter).toBe('local:SomStar-80mm-Series');
	});

	it('the drawer opens only when the pulse PRINTED within the window; a waiting pulse is cancelled, never left behind', async () => {
		let stuck = false;
		answer = (c) => {
			if (c.cmd === 'lp') return ok('request id is SomStar-80mm-Series-70 (0 file(s))\n');
			if (c.cmd === 'lpstat') return ok(stuck ? 'SomStar-80mm-Series-70  x  5  now\n' : '');
			if (c.cmd === 'cancel') return ok();
			return undefined;
		};
		const q = createQueue({ dataDir: tmp(), printers: { receipt: SOMSTAR, kitchen: null } });
		queues.push(q);
		const drawer = createDrawer({ receipt: SOMSTAR, seen: q.seen, log: q.log, sendTimeoutMs: 300 });
		const now = () => new Date().toISOString();
		expect(await drawer.pulse({ id: 'd1', completedAt: now() })).toBe('opened');
		expect(Buffer.from(calls.find((c) => c.cmd === 'lp')!.opts.stdin!)).toEqual(
			Buffer.from(DRAWER_PULSE)
		);
		stuck = true;
		expect(await drawer.pulse({ id: 'd2', completedAt: now() })).toBe('printer_unreachable');
		expect(calls.find((c) => c.cmd === 'cancel')?.args).toEqual(['SomStar-80mm-Series-70']);
		// Refused, so not recorded: the same pulse may be tried again within the window.
		expect(q.seen.has('d2')).toBe(false);
	});
});
