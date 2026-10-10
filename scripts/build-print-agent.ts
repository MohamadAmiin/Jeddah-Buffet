// BUILD THE PRINT AGENT INSTALLERS (tasks/print-agent-installer T-09, T-10).
//
//   pnpm build:print-agent [--origin <url>] [--targets linux-x64,…] [--out <dir>] [--force] [--smoke]
//
// A customer's till PC has nothing installed, so the print agent ships as ONE
// file per OS: the official Node.js binary with the agent bundled and injected
// into it as a single executable application (Node's SEA). This script runs at
// BUILD time — on the deploy server, from scripts/deploy.sh — never on a till.
//
// The app origin is BAKED INTO each installer (a SEA asset, build.json), read
// from --origin or from .env's ORIGIN: the server that serves the download is
// the one that builds it, so a file downloaded from https://pos.example.com
// answers only https://pos.example.com. The agent never adopts an origin from a
// request (the BLOCKER of the plan's risk panel).
//
// Steps: bundle print-agent/src into one CommonJS file (esbuild); make the SEA
// blob with THIS Node (it must be the same version as the binary it goes into,
// so the script refuses any other); download each target's official Node binary
// and check it against the SHA-256 pinned in build-print-agent/lib.ts BEFORE
// using it; inject the blob with postject. The tools used here never reach a
// till: the installer is the Node binary plus the agent, nothing else.
import 'dotenv/config';
import { execFileSync, spawn } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createConfig, parseOrigin, saveConfig } from '../print-agent/src/config';
import { NODE_VERSION, SEA_FUSE, TARGETS, sha256, type Target } from './build-print-agent/lib';

const REPO = resolve(import.meta.dirname, '..');
const CACHE = join(REPO, '.cache', 'print-agent');

const say = (line: string) => process.stdout.write(line + '\n');
function fail(message: string): never {
	process.stderr.write(`✕ ${message}\n`);
	process.exit(1);
}

type Flags = { origin?: string; targets?: string; out: string; force: boolean; smoke: boolean };

function parseArgs(argv: string[]): Flags {
	const flags: Flags = { out: join(REPO, 'dist', 'print-agent'), force: false, smoke: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) fail(`${arg} needs a value`);
			i += 1;
			return next;
		};
		if (arg === '--origin') flags.origin = value();
		else if (arg === '--targets') flags.targets = value();
		else if (arg === '--out') flags.out = resolve(value());
		else if (arg === '--force') flags.force = true;
		else if (arg === '--smoke') flags.smoke = true;
		else fail(`unknown argument ${arg}`);
	}
	return flags;
}

// ── 1. The bundle and the SEA blob ──────────────────────────────────────────

async function bundle(work: string, origin: string): Promise<{ blob: string; bundleSha: string }> {
	const outfile = join(work, 'agent.cjs');
	const result = await build({
		entryPoints: [join(REPO, 'print-agent', 'src', 'main.ts')],
		absWorkingDir: REPO,
		bundle: true,
		platform: 'node',
		target: 'node24',
		format: 'cjs',
		outfile,
		// The only import.meta uses in the agent (paths.ts, main.ts's entry guard),
		// defined away: inside the installer isSea() is the signal, never these.
		define: {
			'import.meta.main': 'false',
			'import.meta.dirname': '""',
			'import.meta.filename': '""'
		},
		metafile: true,
		logLevel: 'silent'
	});
	if (result.warnings.length > 0) {
		for (const warning of result.warnings) process.stderr.write(`  ${warning.text}\n`);
		fail('esbuild warned while bundling the agent — fix the warnings above');
	}
	// The agent must import nothing but node: builtins and its own files.
	for (const input of Object.keys(result.metafile.inputs)) {
		if (!input.startsWith('print-agent/src/')) fail(`the agent bundle pulled in ${input}`);
	}
	const bundleSha = sha256(readFileSync(outfile));
	writeFileSync(
		join(work, 'build.json'),
		JSON.stringify({
			origin,
			agentVersion: 2,
			builtAt: new Date().toISOString(),
			sourceSha: bundleSha
		})
	);
	writeFileSync(
		join(work, 'sea-config.json'),
		JSON.stringify({
			main: 'agent.cjs',
			output: 'sea-prep.blob',
			disableExperimentalSEAWarning: true,
			// Both must be false for a binary built on one OS and run on another (Node docs).
			useSnapshot: false,
			useCodeCache: false,
			assets: { 'build.json': 'build.json' }
		})
	);
	execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
		cwd: work,
		stdio: 'pipe'
	});
	return { blob: join(work, 'sea-prep.blob'), bundleSha };
}

// ── 2. The official Node binaries, checked before use ───────────────────────

async function download(url: string, to: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) fail(`download failed: ${url} → ${response.status}`);
	mkdirSync(join(to, '..'), { recursive: true });
	writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

/** The target's node binary, from the cache when its archive still matches the pinned SHA-256. */
async function nodeBinary(target: Target): Promise<string> {
	const dir = join(CACHE, 'node', NODE_VERSION, target.id);
	const archive = join(dir, target.archive.split('/').pop() as string);
	const matches = () => existsSync(archive) && sha256(readFileSync(archive)) === target.sha256;
	if (!matches()) {
		say(`  downloading ${target.archive}`);
		await download(`https://nodejs.org/dist/${NODE_VERSION}/${target.archive}`, archive);
		if (!matches()) {
			rmSync(archive, { force: true });
			fail(`${target.archive} does not match its pinned SHA-256 — refusing to use it`);
		}
	}
	if (target.binaryInArchive === null) return archive;
	const extracted = join(dir, 'node');
	execFileSync('tar', [
		archive.endsWith('.xz') ? '-xJf' : '-xzf',
		archive,
		'-C',
		dir,
		'--strip-components=2',
		target.binaryInArchive
	]);
	return extracted;
}

/** Copy the node binary (NEVER inject into the cached file) and inject the agent. */
function inject(node: string, out: string, blob: string, macho: boolean): void {
	mkdirSync(join(out, '..'), { recursive: true });
	copyFileSync(node, out);
	chmodSync(out, 0o755);
	const postject = join(REPO, 'node_modules', '.bin', 'postject');
	const args = [out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE];
	if (macho) args.push('--macho-segment-name', 'NODE_SEA');
	execFileSync(postject, args, { stdio: 'pipe' });
}

// ── 3. The smoke test: the Linux installer, run for real ────────────────────

function freePort(): Promise<number> {
	return new Promise((done) => {
		const probe = createServer();
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			probe.close(() => done(port));
		});
	});
}

function http(
	port: number,
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: string
): Promise<{ status: number; json: unknown }> {
	return new Promise((done, reject) => {
		const req = request(
			{ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					let json: unknown = null;
					try {
						json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					} catch {
						json = null;
					}
					done({ status: res.statusCode ?? 0, json });
				});
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

async function smoke(bin: string, origin: string): Promise<void> {
	const check = (ok: boolean, what: string) => {
		if (!ok) fail(`smoke: ${what}`);
		say(`  ● ${what}`);
	};
	const version = execFileSync(bin, ['--version'], { encoding: 'utf8' });
	check(version.includes(origin), `--version names ${origin}`);

	const dir = mkdtempSync(join(tmpdir(), 'matcami-agent-smoke-'));
	const port = await freePort();
	const config = createConfig({ origin, port, dataDir: join(dir, 'data') });
	saveConfig(join(dir, 'config.json'), config);
	const child = spawn(bin, ['run', '--config', join(dir, 'config.json')], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	try {
		await new Promise<void>((done, reject) => {
			const timer = setTimeout(() => reject(new Error('the agent did not start in 10 s')), 10_000);
			child.stdout.on('data', (chunk: Buffer) => {
				if (chunk.toString().includes('listening on')) {
					clearTimeout(timer);
					done();
				}
			});
			child.once('exit', (code) => reject(new Error(`the agent exited with ${code}`)));
		}).catch((error: Error) => fail(`smoke: ${error.message}`));
		check(true, `the installer runs the agent on 127.0.0.1:${port}`);
		const status = await http(port, 'GET', '/status', {
			origin,
			authorization: `Bearer ${config.token}`
		});
		const body = status.json as { agentVersion?: unknown; features?: unknown } | null;
		check(
			status.status === 200 &&
				body?.agentVersion === 2 &&
				Array.isArray(body.features) &&
				body.features.includes('printers'),
			'GET /status answers the app origin: version 2 with the printers feature'
		);
		const setup = await http(
			port,
			'POST',
			'/setup/state',
			{
				origin: `http://127.0.0.1:${port}`,
				'content-type': 'application/json',
				'x-setup-secret': config.setupSecret ?? ''
			},
			'{}'
		);
		check(setup.status === 200, 'POST /setup/state answers the setup key');
		const hostile = await http(port, 'GET', '/status', {
			origin: 'https://evil.example',
			authorization: `Bearer ${config.token}`
		});
		check(hostile.status === 403, 'another origin is refused (403)');
	} finally {
		child.kill();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const flags = parseArgs(process.argv.slice(2));
	const pinned = 'v' + readFileSync(join(REPO, '.nvmrc'), 'utf8').trim();
	if (process.version !== pinned || pinned !== NODE_VERSION) {
		fail(
			`run this with Node ${NODE_VERSION} (nvm use): the SEA blob must be made by the Node it goes into; this is ${process.version}`
		);
	}
	let origin: string;
	try {
		origin = parseOrigin(flags.origin ?? process.env.ORIGIN);
	} catch (error) {
		fail(`the app origin: ${(error as Error).message} — pass --origin or set ORIGIN in .env`);
	}
	const wanted = flags.targets
		? flags.targets.split(',').map((t) => t.trim())
		: TARGETS.map((t) => t.id);
	for (const id of wanted) if (!TARGETS.some((t) => t.id === id)) fail(`unknown target ${id}`);

	const work = mkdtempSync(join(tmpdir(), 'matcami-agent-'));
	try {
		say(`Building the print agent installers for ${origin}`);
		const { blob } = await bundle(work, origin);
		say('● Bundled the agent and made the SEA blob');
		const building = join(flags.out, '.building');
		rmSync(building, { recursive: true, force: true });
		mkdirSync(building, { recursive: true });
		let linuxBinary: string | null = null;
		for (const target of TARGETS.filter((t) => wanted.includes(t.id))) {
			if (target.id !== 'linux-x64') {
				say(`○ ${target.id}: not built yet`);
				continue;
			}
			const node = await nodeBinary(target);
			const out = join(work, target.id, 'matcami-print-agent');
			inject(node, out, blob, false);
			copyFileSync(out, join(building, 'matcami-print-agent-linux-x64'));
			chmodSync(join(building, 'matcami-print-agent-linux-x64'), 0o755);
			linuxBinary = out;
			say(`● ${target.id}: ${join(building, 'matcami-print-agent-linux-x64')}`);
		}
		if (flags.smoke) {
			if (process.platform !== 'linux' || process.arch !== 'x64')
				say('○ smoke skipped: not linux-x64');
			else if (!linuxBinary) say('○ smoke skipped: linux-x64 was not built');
			else {
				say('Smoke test (linux-x64):');
				await smoke(linuxBinary, origin);
			}
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

await main();
