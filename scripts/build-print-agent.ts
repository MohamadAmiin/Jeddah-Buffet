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
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createConfig, parseOrigin, saveConfig } from '../print-agent/src/config';
import {
	BUILD_SCRIPT_VERSION,
	buildKey,
	buildManifest,
	NODE_VERSION,
	RCODESIGN,
	SEA_FUSE,
	TARGETS,
	sha256,
	writeZip,
	verifyAdHocSignature,
	type Manifest,
	type Target
} from './build-print-agent/lib';

const REPO = resolve(import.meta.dirname, '..');
const CACHE = join(REPO, '.cache', 'print-agent');

const say = (line: string) => process.stdout.write(line + '\n');
/** Abort the build. Thrown, not process.exit, so the temporary work folder is still removed. */
function fail(message: string): never {
	throw new Error(message);
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

async function bundle(
	work: string,
	origin: string
): Promise<{ blob: string; bundleSha: string; builtAt: string }> {
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
	const builtAt = new Date().toISOString();
	writeFileSync(
		join(work, 'build.json'),
		JSON.stringify({ origin, agentVersion: 2, builtAt, sourceSha: bundleSha })
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
	return { blob: join(work, 'sea-prep.blob'), bundleSha, builtAt };
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
	// The Windows node.exe and the macOS node are signed by the Node.js project;
	// injecting invalidates that signature and postject warns. Windows runs the
	// result unsigned (Node docs); macOS is re-signed ad hoc below.
	execFileSync(postject, args, { stdio: 'pipe' });
}

/** rcodesign from the cache, checked against its pinned SHA-256 before it is used. */
async function rcodesign(): Promise<string> {
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		fail('the macOS installers are signed with rcodesign on a Linux x64 build host');
	}
	const dir = join(CACHE, 'rcodesign', RCODESIGN.version);
	const archive = join(dir, 'rcodesign.tar.gz');
	const binary = join(dir, 'rcodesign');
	const matches = () => existsSync(archive) && sha256(readFileSync(archive)) === RCODESIGN.sha256;
	if (!matches()) {
		say(`  downloading rcodesign ${RCODESIGN.version}`);
		await download(RCODESIGN.url, archive);
		if (!matches()) {
			rmSync(archive, { force: true });
			fail('rcodesign does not match its pinned SHA-256 — refusing to use it');
		}
	}
	execFileSync('tar', [
		'-xzf',
		archive,
		'-C',
		dir,
		'--strip-components=1',
		RCODESIGN.binaryInArchive
	]);
	chmodSync(binary, 0o755);
	return binary;
}

/**
 * Sign a macOS binary ad hoc, then check the signature the way macOS will
 * (verifyAdHocSignature: every code page against its stored hash). Apple
 * silicon kills an unsigned Mach-O at exec ("Killed: 9"), so a binary that
 * fails here is never shipped — the build aborts instead of falling back to an
 * unsigned file. `rcodesign verify` is not used: it rejects every ad-hoc
 * signature (see RCODESIGN in build-print-agent/lib.ts).
 */
function adHocSign(signer: string, binary: string): number {
	try {
		execFileSync(signer, ['sign', binary], { stdio: 'pipe' });
	} catch (error) {
		const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
		fail(`rcodesign could not sign ${binary}${stderr ? `: ${stderr}` : ''}`);
	}
	const check = verifyAdHocSignature(readFileSync(binary));
	if (!check.ok) fail(`the ad-hoc signature of ${binary} does not check out: ${check.reason}`);
	return check.pages;
}

/** The published file for a target: the bare .exe on Windows, a zip keeping mode 0755 elsewhere. */
function packageTarget(target: Target, binary: string, building: string, builtAt: string): string {
	const out = join(building, target.output);
	if (target.os === 'windows') {
		copyFileSync(binary, out);
	} else {
		const zip = writeZip(
			[{ name: 'matcami-print-agent', data: readFileSync(binary), mode: 0o755 }],
			new Date(builtAt)
		);
		writeFileSync(out, zip);
	}
	return out;
}

/** The installers already in `current/`, when they were built from exactly this agent and origin. */
function unchanged(current: string, key: string): Manifest | null {
	const path = join(current, 'manifest.json');
	if (!existsSync(path)) return null;
	try {
		const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
		if (manifest.buildKey !== key || manifest.files.length !== TARGETS.length) return null;
		for (const file of manifest.files) {
			const full = join(current, file.name);
			if (!existsSync(full) || statSync(full).size !== file.bytes) return null;
		}
		return manifest;
	} catch {
		return null;
	}
}

/**
 * Swap the finished build in: current/ becomes previous/, .building/ becomes
 * current/. The download route only ever sees a complete current/.
 */
function publish(out: string): void {
	const building = join(out, '.building');
	const current = join(out, 'current');
	const previous = join(out, 'previous');
	rmSync(previous, { recursive: true, force: true });
	if (existsSync(current)) renameSync(current, previous);
	renameSync(building, current);
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
		const { blob, bundleSha, builtAt } = await bundle(work, origin);
		const key = buildKey({
			bundleSha,
			origin,
			nodeVersion: NODE_VERSION,
			scriptVersion: BUILD_SCRIPT_VERSION
		});
		say('● Bundled the agent and made the SEA blob');
		// The usual deploy changes neither the agent nor ORIGIN: nothing to download or build.
		const current = join(flags.out, 'current');
		if (
			!flags.force &&
			!flags.smoke &&
			wanted.length === TARGETS.length &&
			unchanged(current, key)
		) {
			say(`● Installers unchanged (${key.slice(0, 12)})`);
			return;
		}
		const building = join(flags.out, '.building');
		rmSync(building, { recursive: true, force: true });
		mkdirSync(building, { recursive: true });
		const files: Array<{ target: Target; bytes: number; sha256: string }> = [];
		let linuxBinary: string | null = null;
		let signer: string | null = null;
		for (const target of TARGETS.filter((t) => wanted.includes(t.id))) {
			const node = await nodeBinary(target);
			const binary = join(
				work,
				target.id,
				target.os === 'windows' ? 'matcami-print-agent.exe' : 'matcami-print-agent'
			);
			inject(node, binary, blob, target.os === 'macos');
			let signed = '';
			if (target.os === 'macos') {
				signer ??= await rcodesign();
				const pages = adHocSign(signer, binary);
				signed = ` — signed ad hoc, all ${pages} page hashes checked`;
			}
			const published = packageTarget(target, binary, building, builtAt);
			const data = readFileSync(published);
			files.push({ target, bytes: data.length, sha256: sha256(data) });
			if (target.id === 'linux-x64') linuxBinary = binary;
			say(`● ${target.id}: ${target.output} (${Math.round(data.length / 1048576)} MB)${signed}`);
		}
		// Before publishing: a binary that fails its smoke test never reaches current/.
		if (flags.smoke) {
			if (process.platform !== 'linux' || process.arch !== 'x64') {
				say('○ smoke skipped: not linux-x64');
			} else if (!linuxBinary) {
				say('○ smoke skipped: linux-x64 was not built');
			} else {
				say('Smoke test (linux-x64):');
				await smoke(linuxBinary, origin);
			}
		}
		const manifest = buildManifest({ origin, builtAt, sourceSha: bundleSha, buildKey: key, files });
		writeFileSync(join(building, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
		publish(flags.out);
		say(`● Published ${files.length} installer(s) to ${current}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`✕ ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
