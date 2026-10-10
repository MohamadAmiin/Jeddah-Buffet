// PURE PIECES OF THE INSTALLER BUILD (tasks/print-agent-installer T-09, T-10).
//
// The installer is the OFFICIAL Node.js binary for each target with the print
// agent injected into it as a single executable application (Node's SEA). Every
// binary the build downloads is checked against a SHA-256 pinned HERE before it
// is used — never against a checksum file fetched at build time, which a
// compromised mirror would serve alongside its own binary. The values below were
// read from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt on 2026-10-10
// (tasks/print-agent-installer/RESEARCH.md).
import { createHash } from 'node:crypto';

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
}): string {
	return sha256(
		[parts.bundleSha, parts.origin, parts.nodeVersion, String(parts.scriptVersion)].join('\n')
	);
}
