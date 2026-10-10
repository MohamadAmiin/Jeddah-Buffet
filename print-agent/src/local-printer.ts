// A PRINTER THIS PC ALREADY KNOWS — plugged in by USB, or shared — reached
// through the PC's own print service: CUPS (`lp`, `lpstat`, `cancel`) on Linux
// and macOS, the print spooler (through PowerShell) on Windows. The agent still
// writes every ESC/POS byte itself (escpos.ts); the service only carries them,
// untouched, to the printer (`-o raw`, or a RAW spooler document).
//
// Why the service and not the device file: a USB printer on Linux is
// /dev/usb/lp0, owned by group `lp`, which the till's user is usually not in,
// and the installer runs without administrator rights (tasks/print-agent-
// installer); the service already has the printer, with no rights needed.
//
// What changes against a network printer (printer.ts), and the one rule that
// matters: the service SPOOLS. `lp` answering is "queued in the service", not
// "printed", and a printer that is off keeps its spool until it comes back. A
// receipt may wait there — that is what a queue is for — but THE DRAWER MAY
// NOT: a pulse that waited would open the drawer by itself when the printer
// returns (invariant 9). So sendNow spools the pulse, watches the service's
// queue for it, and CANCELS it when it has not printed within the timeout,
// answering "unreachable" exactly as a dead network printer would.
//
// Every command runs with a C locale, so `lpstat`'s words are the ones parsed
// here. The commands are injectable (localIo), so the tests run none of them.
import { spawn } from 'node:child_process';
import type { LocalPrinter } from './config.ts';

export type LocalPrinterInfo = {
	name: string;
	/** idle or printing = the service can reach it; stopped = the service gave up on it (off, unplugged, paper). */
	state: 'idle' | 'printing' | 'stopped' | 'unknown';
};

export type ExecOutcome = { status: number; stdout: string; stderr: string };
export type ExecOpts = { stdin?: Uint8Array; timeoutMs: number; env?: Record<string, string> };
export type ExecAsync = (cmd: string, args: string[], opts: ExecOpts) => Promise<ExecOutcome>;

/** The one seam the tests replace; nothing else reads it. */
export const localIo: { exec: ExecAsync; platform: () => NodeJS.Platform } = {
	exec: realExec,
	platform: () => process.platform
};

function realExec(cmd: string, args: string[], opts: ExecOpts): Promise<ExecOutcome> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			windowsHide: true,
			stdio: [opts.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...opts.env }
		});
		let stdout = '';
		let stderr = '';
		let done = false;
		const finish = (status: number, extra = '') => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ status, stdout, stderr: stderr + extra });
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(-1, `${cmd} timed out after ${opts.timeoutMs} ms`);
		}, opts.timeoutMs);
		child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
		child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
		child.on('error', (error) => finish(-1, error.message));
		child.on('close', (code) => finish(code ?? -1));
		if (opts.stdin) {
			child.stdin?.on('error', () => {});
			child.stdin?.end(Buffer.from(opts.stdin));
		}
	});
}

const isWindows = () => localIo.platform() === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Windows: PowerShell, with the script passed base64-encoded so no quoting applies ──

/**
 * `powershell -EncodedCommand`: the script travels as base64 UTF-16LE, so a
 * printer name with quotes or spaces can never break out of it; the name itself
 * reaches the script through an environment variable, never interpolated.
 */
export function powershellArgs(script: string): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		Buffer.from(script, 'utf16le').toString('base64')
	];
}

/** Lists every printer the spooler knows, one `name<TAB>status` per line. */
export const PS_LIST = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Get-Printer | ForEach-Object { "$($_.Name)\`t$($_.PrinterStatus)" }`;

/** One printer's spooler status, or nothing when it is not installed. */
export const PS_STATUS = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = Get-Printer -Name $env:MATCAMI_PRINTER -ErrorAction SilentlyContinue
if ($p) { "$($p.PrinterStatus)\`t$((Get-PrintJob -PrinterName $env:MATCAMI_PRINTER -ErrorAction SilentlyContinue | Measure-Object).Count)" }`;

/**
 * Sends the bytes on stdin as ONE raw document (winspool's RAW datatype: the
 * driver passes them through) and prints the spooler job id. With
 * MATCAMI_WAIT_MS set, waits that long for the job to leave the queue and
 * deletes it when it has not: the drawer rule.
 */
export const PS_SEND = `$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
public class MatcamiRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static int Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "matcami"; di.pDataType = "RAW";
      int job = StartDocPrinter(h, 1, ref di);
      if (job == 0) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      int written;
      if (!WritePrinter(h, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
      EndPagePrinter(h);
      EndDocPrinter(h);
      return job;
    } finally { ClosePrinter(h); }
  }
}
'@
Add-Type -TypeDefinition $code
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
$job = [MatcamiRaw]::Send($env:MATCAMI_PRINTER, $buffer.ToArray())
$wait = [int]($env:MATCAMI_WAIT_MS)
if ($wait -gt 0) {
  $deadline = (Get-Date).AddMilliseconds($wait)
    while ((Get-Date) -lt $deadline) {
    try {
      $j = Get-PrintJob -PrinterName $env:MATCAMI_PRINTER -ID $job -ErrorAction Stop
      if ($j.JobStatus -match 'Completed|Printed') { Write-Output "printed $job"; exit 0 }
    } catch {
      # Gone from the queue = printed. Any other failure says nothing about the
      # job: keep waiting, and let the deadline take it back.
      if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { Write-Output "printed $job"; exit 0 }
    }
    Start-Sleep -Milliseconds 150
  }
  Remove-PrintJob -PrinterName $env:MATCAMI_PRINTER -ID $job -ErrorAction SilentlyContinue
  Write-Output "cancelled $job"
  exit 3
}
Write-Output "spooled $job"`;

// ── CUPS (Linux, macOS) ─────────────────────────────────────────────────────

/**
 * `lpstat -p` lines, C locale: "printer NAME is idle.", "printer NAME now
 * printing NAME-12.", "printer NAME disabled since … -", each followed by
 * indented reason lines. A reason that says the printer is away from the
 * service — unplugged, off, waiting — counts as stopped even while "enabled".
 */
export function parseLpstat(output: string): LocalPrinterInfo[] {
	const printers: LocalPrinterInfo[] = [];
	for (const line of output.split('\n')) {
		const head = /^printer (\S+) (.*)$/.exec(line);
		if (head && head[1]) {
			const rest = head[2] ?? '';
			const state: LocalPrinterInfo['state'] = /^is idle/.test(rest)
				? 'idle'
				: /^now printing/.test(rest)
					? 'printing'
					: /^disabled/.test(rest)
						? 'stopped'
						: 'unknown';
			printers.push({ name: head[1], state });
			continue;
		}
		const last = printers[printers.length - 1];
		if (
			last &&
			/^\s+\S/.test(line) &&
			/unplugged|turned off|waiting for printer|not connected/i.test(line)
		) {
			last.state = 'stopped';
		}
	}
	return printers;
}

/** `Get-Printer` lines, "name<TAB>status": Normal and Printing can print; the rest cannot. */
export function parseGetPrinter(output: string): LocalPrinterInfo[] {
	const printers: LocalPrinterInfo[] = [];
	for (const line of output.split(/\r?\n/)) {
		const at = line.lastIndexOf('\t');
		if (at <= 0) continue;
		const name = line.slice(0, at).trim();
		const status = line.slice(at + 1).trim();
		if (!name) continue;
		printers.push({
			name,
			state: /^Normal$/i.test(status) ? 'idle' : /^Printing$/i.test(status) ? 'printing' : 'stopped'
		});
	}
	return printers;
}

/** The job id `lp` names: "request id is NAME-47 (1 file(s))". */
export function parseRequestId(output: string): string | null {
	const match = /request id is (\S+)/.exec(output);
	return match?.[1] ?? null;
}

let cache: { at: number; printers: LocalPrinterInfo[] } | null = null;
const LIST_CACHE_MS = 5000;

/** Every printer this PC's print service knows, and whether it can reach each one. Cached 5 s. */
export async function listLocalPrinters(): Promise<LocalPrinterInfo[]> {
	if (cache && Date.now() - cache.at < LIST_CACHE_MS) return cache.printers;
	let printers: LocalPrinterInfo[] = [];
	if (isWindows()) {
		const out = await localIo.exec('powershell', powershellArgs(PS_LIST), { timeoutMs: 15_000 });
		if (out.status === 0) printers = parseGetPrinter(out.stdout);
	} else {
		const out = await localIo.exec('lpstat', ['-p'], { timeoutMs: 5000 });
		// A PC with no printer at all answers non-zero ("No destinations added"): an empty list.
		if (out.status === 0) printers = parseLpstat(out.stdout);
	}
	cache = { at: Date.now(), printers };
	return printers;
}

/** Forget the cached list (a test, or right after the printers changed). */
export function forgetLocalPrinters(): void {
	cache = null;
}

/** Can the service reach this printer now? Unknown printers and stopped ones cannot. */
export async function localReachable(printer: LocalPrinter): Promise<boolean> {
	forgetLocalPrinters();
	const found = (await listLocalPrinters()).find((p) => p.name === printer.name);
	return found !== undefined && (found.state === 'idle' || found.state === 'printing');
}

/** Jobs the SERVICE still holds for this printer — what a receipt waits in when the printer is off. */
export async function localQueued(printer: LocalPrinter): Promise<number> {
	if (isWindows()) {
		const out = await localIo.exec('powershell', powershellArgs(PS_STATUS), {
			timeoutMs: 15_000,
			env: helperEnv(printer)
		});
		const count = Number.parseInt(out.stdout.split('\t')[1] ?? '', 10);
		return Number.isFinite(count) ? count : 0;
	}
	const out = await localIo.exec('lpstat', ['-o', printer.name], { timeoutMs: 5000 });
	if (out.status !== 0) return 0;
	return out.stdout.split('\n').filter((line) => line.startsWith(`${printer.name}-`)).length;
}

/**
 * Hand the bytes to the service. Resolves once SPOOLED — the service prints
 * them, now or when the printer comes back — and rejects when the service
 * refused them (no such printer, the service down).
 */
export async function spoolLocal(
	printer: LocalPrinter,
	bytes: Uint8Array,
	timeoutMs: number
): Promise<string> {
	if (isWindows()) {
		const out = await localIo.exec('powershell', powershellArgs(PS_SEND), {
			stdin: bytes,
			timeoutMs: Math.max(timeoutMs, 20_000),
			env: helperEnv(printer)
		});
		const job = /spooled (\S+)/.exec(out.stdout)?.[1];
		if (out.status !== 0 || !job) {
			throw new Error(`printer ${printer.name}: the spooler refused the job: ${out.stderr.trim()}`);
		}
		return job;
	}
	const out = await localIo.exec('lp', ['-d', printer.name, '-o', 'raw'], {
		stdin: bytes,
		timeoutMs
	});
	const job = parseRequestId(out.stdout);
	if (out.status !== 0 || !job) {
		throw new Error(`printer ${printer.name}: lp refused the job: ${out.stderr.trim()}`);
	}
	return job;
}

/**
 * THE DRAWER RULE for a spooled printer: the bytes must PRINT within
 * `timeoutMs`, or they are taken back. Rejects when they were refused, or when
 * they were cancelled unprinted — never leaves a pulse waiting in the service.
 */
export async function sendLocalNow(
	printer: LocalPrinter,
	bytes: Uint8Array,
	timeoutMs: number
): Promise<void> {
	if (isWindows()) {
		const out = await localIo.exec('powershell', powershellArgs(PS_SEND), {
			stdin: bytes,
			timeoutMs: timeoutMs + 20_000,
			env: helperEnv(printer, timeoutMs)
		});
		if (out.status === 0 && /printed /.test(out.stdout)) return;
		throw new Error(
			out.status === 3
				? `printer ${printer.name}: did not print within ${timeoutMs} ms; the job was cancelled`
				: `printer ${printer.name}: the spooler refused the job: ${out.stderr.trim()}`
		);
	}
	const job = await spoolLocal(printer, bytes, timeoutMs);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const out = await localIo.exec('lpstat', ['-o', printer.name], { timeoutMs: 5000 });
		// A failed or hung lpstat says NOTHING about the job — an empty answer is
		// not "gone". Only a successful listing without the job means printed;
		// anything else keeps waiting, and the deadline takes the job back.
		if (out.status === 0) {
			const waiting = out.stdout
				.split('\n')
				.some((line) => line.startsWith(`${job} `) || line.startsWith(`${job}\t`));
			if (!waiting) return;
		}
		await sleep(150);
	}
	await localIo.exec('cancel', [job], { timeoutMs: 5000 });
	throw new Error(
		`printer ${printer.name}: did not print within ${timeoutMs} ms; ${job} was cancelled`
	);
}

/** The env the Windows helpers read the printer name and the wait from — never interpolated into the script. */
export function helperEnv(printer: LocalPrinter, waitMs = 0): Record<string, string> {
	return { MATCAMI_PRINTER: printer.name, MATCAMI_WAIT_MS: String(waitMs) };
}
