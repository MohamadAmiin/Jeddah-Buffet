// THE PRINT AGENT INSTALLERS, AS THE APP SERVES THEM (tasks/print-agent-installer T-12).
//
// scripts/build-print-agent.ts builds one installer per OS at deploy time, into
// dist/print-agent/current/ beside a manifest.json that names each file with
// its size and SHA-256. The till PC downloads its installer before anything is
// paired, so the two routes that serve them are PUBLIC (src/lib/public-routes.ts).
//
// THE RULE THAT KEEPS A PUBLIC FILE ROUTE SAFE: a requested name is only ever
// COMPARED with the names in the manifest, never joined onto a path. SvelteKit
// decodes %2F inside a route parameter, so a request for
// /downloads/print-agent/..%2F..%2F.env arrives as params.file === '../../.env';
// joining that onto the directory would stream the server's .env — the owner
// database credential. The path served is always built from the manifest's own
// entry, and the schema below lets that entry be one of four exact names.
//
// No secret is in any installer: the origin it carries is the app's public
// address, and the pairing token and setup key are minted on the till PC.
import { createReadStream, type ReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const NAME =
	/^matcami-print-agent-(windows-x64\.exe|linux-x64\.zip|macos-arm64\.zip|macos-x64\.zip)$/;
const HEX64 = /^[0-9a-f]{64}$/;

const ManifestSchema = z.object({
	schema: z.literal(1),
	origin: z.string().min(1),
	agentVersion: z.literal(2),
	builtAt: z.string().min(1),
	sourceSha: z.string().regex(HEX64),
	nodeVersion: z.string().min(1),
	buildKey: z.string().regex(HEX64),
	files: z
		.array(
			z.object({
				name: z.string().regex(NAME),
				os: z.enum(['windows', 'linux', 'macos']),
				arch: z.enum(['x64', 'arm64']),
				bytes: z.number().int().positive(),
				sha256: z.string().regex(HEX64),
				verified: z.boolean()
			})
		)
		.max(4)
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestFile = Manifest['files'][number];

export type PublicManifest = {
	builtAt: string;
	origin: string;
	agentVersion: 2;
	files: Array<ManifestFile & { url: string }>;
};

/**
 * Where the installers are: PRINT_AGENT_DIST, else dist/print-agent/current
 * under the app's working directory — adapter-node runs with the checkout as
 * its working directory under PM2 (scripts/deploy.sh).
 */
export function downloadsDir(env: Record<string, string | undefined> = process.env): string {
	return env.PRINT_AGENT_DIST || join(process.cwd(), 'dist', 'print-agent', 'current');
}

let cached: { path: string; mtimeMs: number; manifest: Manifest | null } | null = null;

/** The build's manifest, or null when there is none or it fails the schema. Cached by the file's mtime. */
export async function readManifest(dir: string = downloadsDir()): Promise<Manifest | null> {
	const path = join(dir, 'manifest.json');
	let mtimeMs: number;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		return null;
	}
	if (cached && cached.path === path && cached.mtimeMs === mtimeMs) return cached.manifest;
	let manifest: Manifest | null = null;
	try {
		const parsed = ManifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
		if (parsed.success) manifest = parsed.data;
		else console.error(`[matcami] ${path} does not match the installer manifest schema`);
	} catch {
		console.error(`[matcami] ${path} is not readable JSON`);
	}
	cached = { path, mtimeMs, manifest };
	return manifest;
}

/** What the dashboard and the till may see: the files with their download URLs, nothing else. */
export function publicManifest(manifest: Manifest): PublicManifest {
	return {
		builtAt: manifest.builtAt,
		origin: manifest.origin,
		agentVersion: manifest.agentVersion,
		files: manifest.files.map((file) => ({
			name: file.name,
			os: file.os,
			arch: file.arch,
			bytes: file.bytes,
			sha256: file.sha256,
			verified: file.verified,
			url: `/downloads/print-agent/${file.name}`
		}))
	};
}

/**
 * Open one installer for streaming, or null. `requested` is COMPARED with the
 * manifest's names and never touches a path; a listed file that is missing, or
 * whose size differs from the manifest (a half-copied deploy), is not served.
 */
export async function openDownload(
	dir: string,
	requested: string
): Promise<{ entry: ManifestFile; stream: ReadStream } | null> {
	const manifest = await readManifest(dir);
	const entry = manifest?.files.find((file) => file.name === requested);
	if (!entry) return null;
	const path = join(dir, entry.name);
	try {
		if ((await stat(path)).size !== entry.bytes) return null;
	} catch {
		return null;
	}
	return { entry, stream: createReadStream(path) };
}
