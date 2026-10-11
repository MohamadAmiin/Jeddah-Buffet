// PURE PIECES OF THE INSTALLER BUILD (tasks/print-agent-installer T-09, T-10).
//
// The installer is the OFFICIAL Node.js binary for each target with the print
// agent injected into it as a single executable application (Node's SEA). Every
// binary the build downloads is checked against a SHA-256 pinned HERE before it
// is used — never against a checksum file fetched at build time, which a
// compromised mirror would serve alongside its own binary. The values below were
// read from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt on 2026-10-10
// (tasks/print-agent-installer/RESEARCH.md).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * The ad-hoc signer for the macOS binaries — Apple silicon will not run an
 * unsigned Mach-O at all, and Apple's own codesign exists only on macOS. The
 * SHA-256 was computed on 2026-10-10 and matched the .sha256 the release
 * publishes beside the tarball. Only `rcodesign sign` is used: its `verify`
 * fails on EVERY ad-hoc signature — an ad-hoc signature carries no CMS blob,
 * and verify trips on the empty slot ("CMS error: missing further values"),
 * even for an untouched copy of Node signed ad hoc — so the build checks the
 * result with verifyAdHocSignature below instead.
 */
export const RCODESIGN = {
	version: '0.29.0',
	url: 'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz',
	sha256: 'dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002',
	binaryInArchive: 'apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign'
} as const;

/**
 * False until one run of the macOS installer on a real Apple silicon Mac is
 * recorded (tasks/print-agent-installer T-18): the download card says "not yet
 * checked on a Mac" while it is false.
 */
export const MACOS_VERIFIED = false;

/**
 * False until one run of the Windows installer on a real Windows 10/11 PC is
 * recorded (T-18). The user chose this at the final verification of
 * tasks/print-agent-installer, 2026-10-10 ("Yes, mark Windows too"): no
 * Windows row had run, so the Windows download is marked like the Mac ones.
 */
export const WINDOWS_VERIFIED = false;

/** The Node.js the installer carries. The SEA blob must be made by this exact version. */
export const NODE_VERSION = 'v24.21.0';

/** Bump whenever the pipeline changes, so an unchanged agent is still rebuilt. */
export const BUILD_SCRIPT_VERSION = 1;

/** The fuse Node's SEA support looks for (Node docs, "Single executable applications"). */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export type TargetId = 'linux-x64' | 'windows-x64' | 'macos-arm64' | 'macos-x64';

export type Target = {
	id: TargetId;
	os: 'linux' | 'windows' | 'macos';
	arch: 'x64' | 'arm64';
	/** Path under https://nodejs.org/dist/v24.21.0/. */
	archive: string;
	sha256: string;
	/** The node binary inside a tarball; null when `archive` IS the binary. */
	binaryInArchive: string | null;
	/** What the download is called. */
	output: string;
};

export const TARGETS: readonly Target[] = [
	{
		id: 'linux-x64',
		os: 'linux',
		arch: 'x64',
		archive: 'node-v24.21.0-linux-x64.tar.xz',
		sha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
		binaryInArchive: 'node-v24.21.0-linux-x64/bin/node',
		output: 'matcami-print-agent-linux-x64.zip'
	},
	{
		id: 'windows-x64',
		os: 'windows',
		arch: 'x64',
		archive: 'win-x64/node.exe',
		sha256: 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32',
		binaryInArchive: null,
		output: 'matcami-print-agent-windows-x64.exe'
	},
	{
		id: 'macos-arm64',
		os: 'macos',
		arch: 'arm64',
		archive: 'node-v24.21.0-darwin-arm64.tar.gz',
		sha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
		binaryInArchive: 'node-v24.21.0-darwin-arm64/bin/node',
		output: 'matcami-print-agent-macos-arm64.zip'
	},
	{
		id: 'macos-x64',
		os: 'macos',
		arch: 'x64',
		archive: 'node-v24.21.0-darwin-x64.tar.gz',
		sha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
		binaryInArchive: 'node-v24.21.0-darwin-x64/bin/node',
		output: 'matcami-print-agent-macos-x64.zip'
	}
];

/** Every download name, in the shape the app's download route allows (src/lib/server/print-agent-downloads.ts). */
export const OUTPUT_NAME = /^matcami-print-agent-[a-z0-9-]+\.(exe|zip)$/;

export function sha256(data: Buffer | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * What decides whether the installers must be rebuilt: the bundled agent, the
 * origin baked into it, the Node version and this script's version. Same key,
 * same installers.
 */
export function buildKey(parts: {
	bundleSha: string;
	origin: string;
	nodeVersion: string;
	scriptVersion: number;
	/**
	 * The "checked on its own OS" flags the manifest carries. In the key so that
	 * flipping one after a real-machine run reaches the manifest on the next
	 * deploy — deploy.sh never passes --force, and the skip rule would keep the
	 * old manifest.
	 */
	verified: { macos: boolean; windows: boolean };
	/**
	 * Whether the Windows installer is signed with a trusted certificate (a
	 * signing command is configured). In the key so that configuring signing
	 * rebuilds an installer that was published unsigned.
	 */
	signedWindows: boolean;
}): string {
	return sha256(
		[
			parts.bundleSha,
			parts.origin,
			parts.nodeVersion,
			String(parts.scriptVersion),
			`macos=${parts.verified.macos}`,
			`windows=${parts.verified.windows}`,
			`signed-windows=${parts.signedWindows}`
		].join('\n')
	);
}

// ── Windows: the Authenticode signature table ───────────────────────────────
//
// node.exe comes signed by the Node.js project. Injecting the agent changes the
// file, so that signature no longer matches — and postject leaves the PE
// header's Security directory pointing at a table that is no longer there. A
// file that CLAIMS a signature it does not carry is worse than an unsigned one:
// Windows treats it as tampered. So the signature is removed before injection
// (what the Node docs do with `signtool remove /s`), leaving a cleanly unsigned
// .exe — which is also the only state a trusted certificate can sign.
//
// Smart App Control (Windows 11) blocks unknown, unsigned programs outright,
// with no "run anyway": only a signature from a certificate authority in
// Microsoft's Trusted Root Program lets the installer run on such a PC. The
// build signs it when PRINT_AGENT_SIGN_WINDOWS names a signing command.

/** Where the PE header keeps its checksum and its Security (Authenticode) directory entry. */
function peLayout(pe: Buffer): { checksumAt: number; securityAt: number } | null {
	if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
	const header = pe.readUInt32LE(0x3c);
	if (header + 24 > pe.length || pe.readUInt32LE(header) !== 0x00004550) return null; // 'PE\0\0'
	const optional = header + 24;
	if (optional + 2 > pe.length) return null;
	const magic = pe.readUInt16LE(optional);
	const pe32plus = magic === 0x20b;
	if (!pe32plus && magic !== 0x10b) return null;
	const countAt = optional + (pe32plus ? 108 : 92);
	const directories = optional + (pe32plus ? 112 : 96);
	if (directories + 5 * 8 > pe.length || pe.readUInt32LE(countAt) < 5) return null;
	return { checksumAt: optional + 64, securityAt: directories + 4 * 8 };
}

/**
 * What a Windows binary says about its Authenticode signature, by structure
 * only (the certificate chain is Windows' to check): `unsigned` — no table;
 * `signed` — a WIN_CERTIFICATE of type PKCS_SIGNED_DATA inside the file;
 * `corrupt` — a table entry pointing at anything else; `not-pe` otherwise.
 */
export function authenticodeState(pe: Buffer): 'unsigned' | 'signed' | 'corrupt' | 'not-pe' {
	const layout = peLayout(pe);
	if (!layout) return 'not-pe';
	const offset = pe.readUInt32LE(layout.securityAt);
	const size = pe.readUInt32LE(layout.securityAt + 4);
	if (offset === 0 && size === 0) return 'unsigned';
	if (size < 8 || offset + size > pe.length) return 'corrupt';
	const length = pe.readUInt32LE(offset);
	const revision = pe.readUInt16LE(offset + 4);
	const type = pe.readUInt16LE(offset + 6);
	return length >= 8 && length <= size && revision === 0x0200 && type === 0x0002
		? 'signed'
		: 'corrupt';
}

/** The PE checksum (imagehlp's CheckSumMappedFile): 16-bit one's-complement sum, plus the length. */
export function peChecksum(pe: Buffer, checksumAt: number): number {
	let sum = 0;
	for (let i = 0; i < pe.length; i += 2) {
		if (i === checksumAt || i === checksumAt + 2) continue;
		sum += i + 1 < pe.length ? pe.readUInt16LE(i) : (pe[i] as number);
		sum = (sum & 0xffff) + (sum >>> 16);
	}
	sum = (sum & 0xffff) + (sum >>> 16);
	return (sum + pe.length) >>> 0;
}

/**
 * A copy of the binary with its Authenticode table removed: the directory
 * entry zeroed, the table cut off the end of the file where it lives, and the
 * checksum recomputed. An unsigned binary comes back unchanged.
 */
export function stripAuthenticode(pe: Buffer): Buffer {
	const layout = peLayout(pe);
	if (!layout) throw new Error('not a Windows PE file');
	const offset = pe.readUInt32LE(layout.securityAt);
	const size = pe.readUInt32LE(layout.securityAt + 4);
	if (offset === 0 && size === 0) return Buffer.from(pe);
	// The table is the last thing in a signed file; anything else is left in place.
	const out = Buffer.from(offset > 0 && offset + size === pe.length ? pe.subarray(0, offset) : pe);
	out.writeUInt32LE(0, layout.securityAt);
	out.writeUInt32LE(0, layout.securityAt + 4);
	if (layout.checksumAt % 2 === 0)
		out.writeUInt32LE(peChecksum(out, layout.checksumAt), layout.checksumAt);
	return out;
}

// ── The ZIP the Linux and macOS installers ship in ─────────────────────────

const dosTime = (d: Date) =>
	((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
const dosDate = (d: Date) =>
	(((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/**
 * A dependency-free ZIP: deflated entries, each carrying its UNIX mode, so the
 * unzipped installer keeps its execute bit (a browser saves a bare download
 * without it). "Version made by" 3 = UNIX, which is what tells an unzipper the
 * high 16 bits of the external attributes are a mode. No ZIP64: an entry must
 * stay under 4 GiB.
 */
export function writeZip(
	entries: Array<{ name: string; data: Buffer; mode: number }>,
	when: Date = new Date()
): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		if (entry.data.length >= 0xffffffff) throw new Error(`${entry.name} is too large for a ZIP`);
		const name = Buffer.from(entry.name, 'utf8');
		const packed = deflateRawSync(entry.data, { level: 9 });
		const crc = crc32(entry.data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed: 2.0
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(dosTime(when), 10);
		local.writeUInt16LE(dosDate(when), 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE((3 << 8) | 20, 4); // made by UNIX, 2.0
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x0800, 8);
		record.writeUInt16LE(8, 10);
		record.writeUInt16LE(dosTime(when), 12);
		record.writeUInt16LE(dosDate(when), 14);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(packed.length, 20);
		record.writeUInt32LE(entry.data.length, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38); // regular file + mode
		record.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(record, name);
		offset += local.length + name.length + packed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

// ── The ad-hoc signature check ──────────────────────────────────────────────

export type SignatureCheck = { ok: true; pages: number } | { ok: false; reason: string };

/**
 * Check an ad-hoc signed, thin 64-bit Mach-O the way macOS does when it runs
 * one: find the embedded signature (LC_CODE_SIGNATURE → SuperBlob →
 * CodeDirectory), require the CS_ADHOC flag, require the code to cover
 * everything before the signature, then RECOMPUTE the hash of every code page
 * and compare it with the hash the CodeDirectory stores. An unsigned binary
 * (postject strips the signature), a Node-signed one or a single changed byte
 * all fail. Multi-byte fields of the signature are big-endian; the Mach-O
 * header is little-endian (arm64 and x86_64).
 */
export function verifyAdHocSignature(binary: Buffer): SignatureCheck {
	try {
		if (binary.readUInt32LE(0) !== 0xfeedfacf)
			return { ok: false, reason: 'not a thin 64-bit Mach-O' };
		const commands = binary.readUInt32LE(16);
		let at = 32;
		let signature: { offset: number; size: number } | null = null;
		for (let i = 0; i < commands; i += 1) {
			const cmd = binary.readUInt32LE(at);
			const size = binary.readUInt32LE(at + 4);
			if (cmd === 0x1d) {
				signature = { offset: binary.readUInt32LE(at + 8), size: binary.readUInt32LE(at + 12) };
			}
			if (size < 8) return { ok: false, reason: 'malformed load command' };
			at += size;
		}
		if (!signature) return { ok: false, reason: 'no LC_CODE_SIGNATURE (unsigned)' };
		const blob = signature.offset;
		if (binary.readUInt32BE(blob) !== 0xfade0cc0)
			return { ok: false, reason: 'no signature SuperBlob' };
		let directory = -1;
		const count = binary.readUInt32BE(blob + 8);
		for (let i = 0; i < count; i += 1) {
			if (binary.readUInt32BE(blob + 12 + i * 8) === 0) {
				directory = blob + binary.readUInt32BE(blob + 16 + i * 8);
			}
		}
		if (directory < 0 || binary.readUInt32BE(directory) !== 0xfade0c02) {
			return { ok: false, reason: 'no CodeDirectory' };
		}
		const flags = binary.readUInt32BE(directory + 12);
		const hashOffset = binary.readUInt32BE(directory + 16);
		const codeSlots = binary.readUInt32BE(directory + 28);
		const codeLimit = binary.readUInt32BE(directory + 32);
		const hashSize = binary.readUInt8(directory + 36);
		const hashType = binary.readUInt8(directory + 37);
		const pageSize = 2 ** binary.readUInt8(directory + 39);
		if ((flags & 0x2) === 0)
			return { ok: false, reason: 'not an ad-hoc signature (CS_ADHOC unset)' };
		const algorithm = hashType === 2 ? 'sha256' : hashType === 1 ? 'sha1' : null;
		if (!algorithm) return { ok: false, reason: `unknown hash type ${hashType}` };
		if (codeLimit !== signature.offset) {
			return {
				ok: false,
				reason: `the code ends at ${codeLimit}, the signature starts at ${signature.offset}`
			};
		}
		if (codeSlots !== Math.ceil(codeLimit / pageSize)) {
			return { ok: false, reason: 'the CodeDirectory does not cover every page' };
		}
		for (let page = 0; page < codeSlots; page += 1) {
			const stored = binary.subarray(
				directory + hashOffset + page * hashSize,
				directory + hashOffset + (page + 1) * hashSize
			);
			const actual = createHash(algorithm)
				.update(binary.subarray(page * pageSize, Math.min((page + 1) * pageSize, codeLimit)))
				.digest()
				.subarray(0, hashSize);
			if (!actual.equals(stored))
				return { ok: false, reason: `page ${page} does not match its hash` };
		}
		return { ok: true, pages: codeSlots };
	} catch {
		return { ok: false, reason: 'malformed Mach-O' };
	}
}

/**
 * The operator's signing command for the Windows installer (.env
 * PRINT_AGENT_SIGN_WINDOWS), with `{file}` where the .exe goes — whatever the
 * certificate provider documents for signing on Linux (osslsigncode, jsign, a
 * cloud signing tool). Null when none is configured; an error when it cannot
 * say where the file goes.
 */
export function windowsSigningCommand(env: Record<string, string | undefined>): string | null {
	const command = (env.PRINT_AGENT_SIGN_WINDOWS ?? '').trim();
	if (!command) return null;
	if (!command.includes('{file}')) {
		throw new Error('PRINT_AGENT_SIGN_WINDOWS must contain {file} where the .exe to sign goes');
	}
	return command;
}

/** The command line with `{file}` replaced by the path, single-quoted for sh. */
export function signingCommandLine(command: string, file: string): string {
	return command.split('{file}').join(`'${file.replace(/'/g, `'\\''`)}'`);
}

export type ShellRun = (line: string) => { status: number | null; output: string };

const shellRun: ShellRun = (line) => {
	const result = spawnSync('sh', ['-c', line], { encoding: 'utf8', stdio: 'pipe' });
	return { status: result.status, output: `${result.stderr ?? ''}${result.stdout ?? ''}`.trim() };
};

/**
 * Sign the installer with the operator's command, then check it is signed.
 * Smart App Control lets only trusted-signed programs run, so a command that
 * fails, or leaves the file unsigned, is an error: the build stops and the
 * previous installers stay published.
 */
export function signWindowsInstaller(
	file: string,
	command: string,
	run: ShellRun = shellRun
): void {
	const result = run(signingCommandLine(command, file));
	if (result.status !== 0) {
		throw new Error(
			`signing the Windows installer failed: ${result.output || `exit ${result.status}`}`
		);
	}
	const state = authenticodeState(readFileSync(file));
	if (state !== 'signed')
		throw new Error(`the Windows installer is ${state} after the signing command`);
}

// ── The manifest the app's download routes serve ────────────────────────────

export type ManifestFile = {
	name: string;
	os: Target['os'];
	arch: Target['arch'];
	bytes: number;
	sha256: string;
	/** Run on its own OS and recorded (T-18). The macOS and Windows files stay false until then. */
	verified: boolean;
	/**
	 * Signed with a trusted certificate. Only the Windows file can be: Smart App
	 * Control blocks it otherwise. (The macOS ad-hoc signature is not a trusted one.)
	 */
	signed: boolean;
};

export type Manifest = {
	schema: 1;
	origin: string;
	agentVersion: 2;
	builtAt: string;
	sourceSha: string;
	nodeVersion: string;
	buildKey: string;
	files: ManifestFile[];
};

export function buildManifest(args: {
	origin: string;
	builtAt: string;
	sourceSha: string;
	buildKey: string;
	files: Array<{ target: Target; bytes: number; sha256: string }>;
	/** The Windows installer was signed by the configured signing command. */
	signedWindows?: boolean;
}): Manifest {
	return {
		schema: 1,
		origin: args.origin,
		agentVersion: 2,
		builtAt: args.builtAt,
		sourceSha: args.sourceSha,
		nodeVersion: NODE_VERSION,
		buildKey: args.buildKey,
		files: args.files.map(({ target, bytes, sha256: hash }) => ({
			name: target.output,
			os: target.os,
			arch: target.arch,
			bytes,
			sha256: hash,
			verified:
				target.os === 'macos' ? MACOS_VERIFIED : target.os === 'windows' ? WINDOWS_VERIFIED : true,
			signed: target.os === 'windows' && args.signedWindows === true
		}))
	};
}
