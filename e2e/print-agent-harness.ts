// THE REAL PRINT AGENT, AS ITS OWN PROCESS, for the e2e journeys that print —
// e2e/printing.spec.ts and e2e/settings-receipt.spec.ts. Moved out of
// printing.spec.ts by tasks/settings-tax-payments-receipt T-35 so both journeys
// write, spawn, pair and stop the agent the same way. Every helper takes the
// config path or the child process as a PARAMETER: each spec keeps its own
// `agent` variable and its own beforeAll/afterAll. Not a spec — Playwright
// collects only files named *.spec.ts.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Playwright's baseURL: what the till's browser sends as Origin. */
const ORIGIN = 'http://localhost:4173';

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/**
 * Write the agent's config.json into `dir` and return its path. Receipt 32
 * columns (58 mm), kitchen 48 (80 mm): the two widths in one run. The file is
 * 0600 because it holds the pairing token. `printers: null` writes an agent with
 * no printer yet — what the installer leaves until the owner enters one
 * (print-agent-installer T-16).
 */
export function writeAgentConfig(
	dir: string,
	c: { agentPort: number; token: string } & (
		{ receiptPort: number; kitchenPort: number; printers?: undefined } | { printers: null }
	)
): string {
	const configPath = join(dir, 'config.json');
	writeFileSync(
		configPath,
		JSON.stringify({
			origin: ORIGIN,
			token: c.token,
			port: c.agentPort,
			printers:
				c.printers === null
					? { receipt: null, kitchen: null }
					: {
							receipt: { host: '127.0.0.1', port: c.receiptPort, width: 32 },
							kitchen: { host: '127.0.0.1', port: c.kitchenPort, width: 48 }
						},
			dataDir: join(dir, 'data')
		}),
		{ mode: 0o600 }
	);
	return configPath;
}

/**
 * A fake print service on PATH for the spawned agent (feat/local-printers):
 * `lpstat -p` lists one idle printer, `lp` appends its stdin to a tape file and
 * answers a request id, `cancel` succeeds. The agent runs them in a C locale,
 * exactly as it would run CUPS. Linux and macOS only — the e2e host is Linux.
 */
export function fakeCups(
	dir: string,
	printerName = 'Fake-Thermal'
): { env: Record<string, string>; tape: string } {
	const bin = join(dir, 'fake-cups');
	mkdirSync(bin, { recursive: true });
	const tape = join(dir, 'cups-tape.bin');
	const script = (name: string, body: string) =>
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	script(
		'lpstat',
		`case "$1" in -p) echo "printer ${printerName} is idle.  enabled since Sat Oct 10 15:54:12 2026";; esac\nexit 0`
	);
	script('lp', `cat >> "$FAKE_CUPS_TAPE"\necho "request id is ${printerName}-$$ (0 file(s))"`);
	script('cancel', 'exit 0');
	return { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_CUPS_TAPE: tape }, tape };
}

/** Spawn the real agent and resolve once it says it is listening. `env` is added to the process's. */
export function startAgent(
	configPath: string,
	env: Record<string, string> = {}
): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['print-agent/src/main.ts', 'run', '--config', configPath],
			{
				cwd: process.cwd(),
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, ...env }
			}
		);
		const timer = setTimeout(
			() => reject(new Error('the print agent never said listening')),
			20_000
		);
		let errors = '';
		child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString()));
		child.stdout?.on('data', (chunk: Buffer) => {
			if (chunk.toString().includes('listening')) {
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timer);
			if (code !== null && code !== 0)
				reject(new Error(`the print agent exited ${code}: ${errors}`));
		});
	});
}

/** The pairing link, from the agent's own `link` command — the line an operator reads. */
export function agentPairingLink(configPath: string): string {
	const out = execFileSync(
		process.execPath,
		['print-agent/src/main.ts', 'link', '--config', configPath],
		{ cwd: process.cwd(), encoding: 'utf8' }
	);
	const match = /^Pairing link:\s+(\S+)$/m.exec(out);
	if (!match?.[1]) throw new Error(`the agent printed no pairing link:\n${out}`);
	return match[1];
}

/** Run the agent's own `pair` command: opens pairing, prints no secret. */
export function openAgentPairing(configPath: string): string {
	return execFileSync(
		process.execPath,
		['print-agent/src/main.ts', 'pair', '--config', configPath],
		{ cwd: process.cwd(), encoding: 'utf8' }
	);
}

/** Stop the agent: SIGINT, then SIGKILL after 3 s. The caller drops its own reference. */
export function stopAgent(child: ChildProcess | null): Promise<void> {
	return new Promise((resolve) => {
		if (!child || child.exitCode !== null) return resolve();
		child.once('exit', () => resolve());
		child.kill('SIGINT');
		setTimeout(() => child.kill('SIGKILL'), 3000).unref();
	});
}
