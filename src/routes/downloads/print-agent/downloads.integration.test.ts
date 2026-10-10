// The print agent installer routes (tasks/print-agent-installer T-12). In the
// integration project only because the route modules import $lib, which the
// unit project does not alias; no database is touched.
//
// MANDATORY for this plan: the routes are PUBLIC, so a request value must never
// reach a path. SvelteKit decodes %2F inside params.file — a joined '../../.env'
// would stream the server's database credentials.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	openDownload,
	publicManifest,
	readManifest,
	type Manifest
} from '$lib/server/print-agent-downloads';
import { GET as manifestGET } from './+server';
import { GET as fileGET } from './[file]/+server';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const WINDOWS = Buffer.from('MZ fake windows installer');
const LINUX = Buffer.from('PK fake linux zip');

let root: string;
let dir: string;
const previous = process.env.PRINT_AGENT_DIST;

function manifestFor(
	files: Array<{ name: string; data: Buffer; os: 'windows' | 'linux' }>
): Manifest {
	return {
		schema: 1,
		origin: 'https://pos.example.com',
		agentVersion: 2,
		builtAt: '2026-10-10T09:00:00.000Z',
		sourceSha: 'a'.repeat(64),
		nodeVersion: 'v24.21.0',
		buildKey: 'b'.repeat(64),
		files: files.map((f) => ({
			name: f.name,
			os: f.os,
			arch: 'x64',
			bytes: f.data.length,
			sha256: sha(f.data),
			verified: true
		}))
	};
}

beforeEach(() => {
	// root/app/dist/current — with a real .env two levels above the downloads folder.
	root = mkdtempSync(join(tmpdir(), 'matcami-downloads-'));
	dir = join(root, 'app', 'dist', 'current');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(root, 'app', '.env'), 'MIGRATE_DATABASE_URL=postgres://owner:SECRET@db/x\n');
	writeFileSync(join(dir, 'matcami-print-agent-windows-x64.exe'), WINDOWS);
	writeFileSync(join(dir, 'matcami-print-agent-linux-x64.zip'), LINUX);
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify(
			manifestFor([
				{ name: 'matcami-print-agent-windows-x64.exe', data: WINDOWS, os: 'windows' },
				{ name: 'matcami-print-agent-linux-x64.zip', data: LINUX, os: 'linux' }
			])
		)
	);
	process.env.PRINT_AGENT_DIST = dir;
});

afterEach(() => {
	if (previous === undefined) delete process.env.PRINT_AGENT_DIST;
	else process.env.PRINT_AGENT_DIST = previous;
	rmSync(root, { recursive: true, force: true });
});

const fileEvent = (file: string) => ({ params: { file } }) as unknown as RequestEvent;
const manifestEvent = () => ({ params: {} }) as unknown as RequestEvent;

describe('MANDATORY (the traversal BLOCKER): a request value never reaches a path', () => {
	it.each([
		'../../.env',
		'..%2F..%2F.env',
		'%2e%2e%2f.env',
		'..\\..\\.env',
		'../.env',
		'matcami-print-agent-windows-x64.exe.',
		'MATCAMI-PRINT-AGENT-WINDOWS-X64.EXE',
		'manifest.json',
		''
	])('openDownload(%j) is null', async (requested) => {
		expect(await openDownload(dir, requested)).toBeNull();
	});

	it('the route answers 404 for the decoded traversal and never streams .env', async () => {
		await expect(fileGET(fileEvent('../../.env'))).rejects.toMatchObject({ status: 404 });
		await expect(fileGET(fileEvent('../.env'))).rejects.toMatchObject({ status: 404 });
	});
});

describe('GET /downloads/print-agent/[file]', () => {
	it('streams a listed installer with every header the plan names', async () => {
		const response = await fileGET(fileEvent('matcami-print-agent-windows-x64.exe'));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		expect(response.headers.get('content-length')).toBe(String(WINDOWS.length));
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="matcami-print-agent-windows-x64.exe"'
		);
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(Buffer.from(await response.arrayBuffer()).equals(WINDOWS)).toBe(true);
	});

	it('a listed file whose size differs from the manifest (a half-copied deploy) is 404', async () => {
		writeFileSync(join(dir, 'matcami-print-agent-linux-x64.zip'), Buffer.from('truncated'));
		await expect(fileGET(fileEvent('matcami-print-agent-linux-x64.zip'))).rejects.toMatchObject({
			status: 404
		});
	});

	it('a listed file that is missing is 404', async () => {
		rmSync(join(dir, 'matcami-print-agent-linux-x64.zip'));
		await expect(fileGET(fileEvent('matcami-print-agent-linux-x64.zip'))).rejects.toMatchObject({
			status: 404
		});
	});
});

describe('GET /downloads/print-agent — the manifest', () => {
	it('answers the files with their URLs and nothing beyond the public fields', async () => {
		const response = await manifestGET(manifestEvent());
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as ReturnType<typeof publicManifest>;
		expect(Object.keys(body).sort()).toEqual(['agentVersion', 'builtAt', 'files', 'origin']);
		expect(body.files.map((f) => f.url)).toEqual([
			'/downloads/print-agent/matcami-print-agent-windows-x64.exe',
			'/downloads/print-agent/matcami-print-agent-linux-x64.zip'
		]);
		for (const file of body.files) {
			expect(Object.keys(file).sort()).toEqual(
				['arch', 'bytes', 'name', 'os', 'sha256', 'url', 'verified'].sort()
			);
		}
	});

	it('no build yet → 404 not_built', async () => {
		process.env.PRINT_AGENT_DIST = join(root, 'nothing-here');
		const response = await manifestGET(manifestEvent());
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'not_built' });
	});

	it('a manifest naming a path instead of an installer is refused outright', async () => {
		const other = join(root, 'tampered');
		mkdirSync(other);
		const bad = manifestFor([{ name: '../x.exe', data: WINDOWS, os: 'windows' }]);
		writeFileSync(join(other, 'manifest.json'), JSON.stringify(bad));
		expect(await readManifest(other)).toBeNull();
		expect(await openDownload(other, '../x.exe')).toBeNull();
	});
});
