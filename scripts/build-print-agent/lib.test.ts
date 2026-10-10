import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	BUILD_SCRIPT_VERSION,
	buildKey,
	buildManifest,
	MACOS_VERIFIED,
	NODE_VERSION,
	OUTPUT_NAME,
	RCODESIGN,
	TARGETS,
	verifyAdHocSignature,
	WINDOWS_VERIFIED,
	writeZip
} from './lib';

describe('writeZip — the Linux and macOS downloads', () => {
	const zip = writeZip(
		[{ name: 'matcami-print-agent', data: Buffer.from('hello'), mode: 0o755 }],
		new Date('2026-10-10T09:30:00')
	);

	it('round-trips: name, UNIX mode 0100755, CRC and the deflated bytes', () => {
		// End of central directory → the one central record → the local entry.
		const end = zip.length - 22;
		expect(zip.readUInt32LE(end)).toBe(0x06054b50);
		expect(zip.readUInt16LE(end + 10)).toBe(1);
		const central = zip.readUInt32LE(end + 16);
		expect(zip.readUInt32LE(central)).toBe(0x02014b50);
		expect(zip.readUInt16LE(central + 4) >> 8).toBe(3); // made by UNIX
		expect(zip.readUInt32LE(central + 16)).toBe(crc32('hello') >>> 0);
		expect((zip.readUInt32LE(central + 38) >>> 16) & 0o177777).toBe(0o100755);
		const nameLength = zip.readUInt16LE(central + 28);
		expect(zip.toString('utf8', central + 46, central + 46 + nameLength)).toBe(
			'matcami-print-agent'
		);
		const local = zip.readUInt32LE(central + 42);
		expect(zip.readUInt32LE(local)).toBe(0x04034b50);
		const packedSize = zip.readUInt32LE(local + 18);
		const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		expect(inflateRawSync(zip.subarray(dataStart, dataStart + packedSize)).toString()).toBe(
			'hello'
		);
	});

	const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
	it.skipIf(!hasUnzip)('unzip lists it as -rwxr-xr-x', () => {
		const dir = mkdtempSync(join(tmpdir(), 'matcami-zip-'));
		try {
			writeFileSync(join(dir, 't.zip'), zip);
			expect(execFileSync('unzip', ['-Z', join(dir, 't.zip')], { encoding: 'utf8' })).toMatch(
				/-rwxr-xr-x .* matcami-print-agent/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** A tiny thin 64-bit Mach-O with an embedded ad-hoc signature over three pages (4096, 4096, 100). */
function signedMachO(options: { adHoc?: boolean } = {}): Buffer {
	const page = 4096;
	const codeLimit = 2 * page + 100;
	const slots = Math.ceil(codeLimit / page);
	const hashOffset = 88;
	const directoryLength = hashOffset + slots * 32;
	const directoryAt = 20; // after the SuperBlob header and its one index entry
	const signatureLength = directoryAt + directoryLength;
	const code = Buffer.alloc(codeLimit, 0x41);
	code.writeUInt32LE(0xfeedfacf, 0);
	code.writeUInt32LE(1, 16); // one load command
	code.writeUInt32LE(16, 20);
	code.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
	code.writeUInt32LE(16, 36);
	code.writeUInt32LE(codeLimit, 40);
	code.writeUInt32LE(signatureLength, 44);
	const signature = Buffer.alloc(signatureLength);
	signature.writeUInt32BE(0xfade0cc0, 0);
	signature.writeUInt32BE(signatureLength, 4);
	signature.writeUInt32BE(1, 8);
	signature.writeUInt32BE(0, 12); // CSSLOT_CODEDIRECTORY
	signature.writeUInt32BE(directoryAt, 16);
	signature.writeUInt32BE(0xfade0c02, directoryAt);
	signature.writeUInt32BE(directoryLength, directoryAt + 4);
	signature.writeUInt32BE(0x20400, directoryAt + 8);
	signature.writeUInt32BE(options.adHoc === false ? 0 : 0x2, directoryAt + 12);
	signature.writeUInt32BE(hashOffset, directoryAt + 16);
	signature.writeUInt32BE(slots, directoryAt + 28);
	signature.writeUInt32BE(codeLimit, directoryAt + 32);
	signature.writeUInt8(32, directoryAt + 36);
	signature.writeUInt8(2, directoryAt + 37); // SHA-256
	signature.writeUInt8(12, directoryAt + 39); // 4096-byte pages
	for (let i = 0; i < slots; i += 1) {
		createHash('sha256')
			.update(code.subarray(i * page, Math.min((i + 1) * page, codeLimit)))
			.digest()
			.copy(signature, directoryAt + hashOffset + i * 32);
	}
	return Buffer.concat([code, signature]);
}

describe('verifyAdHocSignature — what macOS checks before running an ad-hoc binary', () => {
	it('accepts a binary whose every page matches its stored hash', () => {
		expect(verifyAdHocSignature(signedMachO())).toEqual({ ok: true, pages: 3 });
	});

	it('refuses one changed byte, naming the page', () => {
		const tampered = signedMachO();
		tampered[5000] = tampered[5000]! ^ 0xff;
		expect(verifyAdHocSignature(tampered)).toEqual({
			ok: false,
			reason: 'page 1 does not match its hash'
		});
	});

	it('refuses a signature that is not ad hoc, and a binary with no signature at all', () => {
		expect(verifyAdHocSignature(signedMachO({ adHoc: false }))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/CS_ADHOC/)
		});
		const unsigned = signedMachO();
		unsigned.writeUInt32LE(0x19, 32); // the load command is no longer LC_CODE_SIGNATURE
		expect(verifyAdHocSignature(unsigned)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/unsigned/)
		});
	});

	it('refuses something that is not a Mach-O, and a truncated one, without throwing', () => {
		expect(verifyAdHocSignature(Buffer.from('MZ not a mach-o at all'))).toMatchObject({
			ok: false
		});
		expect(verifyAdHocSignature(signedMachO().subarray(0, 2 * 4096 + 100 + 30))).toMatchObject({
			ok: false
		});
	});
});

describe('the manifest and the pinned signer', () => {
	it('marks the macOS and Windows files unverified until a run on each is recorded; Linux verified', () => {
		expect(MACOS_VERIFIED).toBe(false);
		expect(WINDOWS_VERIFIED).toBe(false);
		const manifest = buildManifest({
			origin: 'https://pos.example.com',
			builtAt: '2026-10-10T09:30:00.000Z',
			sourceSha: 'a'.repeat(64),
			buildKey: 'b'.repeat(64),
			files: TARGETS.map((target) => ({ target, bytes: 1, sha256: 'c'.repeat(64) }))
		});
		expect(manifest.schema).toBe(1);
		expect(manifest.nodeVersion).toBe(NODE_VERSION);
		expect(manifest.files.map((f) => [f.name, f.verified])).toEqual([
			['matcami-print-agent-linux-x64.zip', true],
			['matcami-print-agent-windows-x64.exe', false],
			['matcami-print-agent-macos-arm64.zip', false],
			['matcami-print-agent-macos-x64.zip', false]
		]);
	});

	it('rcodesign is pinned to a version and a SHA-256', () => {
		expect(RCODESIGN.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(RCODESIGN.url).toContain(`/apple-codesign/${RCODESIGN.version}/`);
	});
});

describe('the installer targets', () => {
	it('are exactly the four the plan names, each pinned to a SHA-256', () => {
		expect(TARGETS.map((t) => t.id)).toEqual([
			'linux-x64',
			'windows-x64',
			'macos-arm64',
			'macos-x64'
		]);
		for (const t of TARGETS) {
			expect(t.sha256, t.id).toMatch(/^[0-9a-f]{64}$/);
			expect(t.output, t.id).toMatch(OUTPUT_NAME);
			expect(t.archive.includes(NODE_VERSION.slice(1)) || t.archive === 'win-x64/node.exe').toBe(
				true
			);
		}
	});

	it('Windows ships a bare .exe; Linux and macOS ship zips (a browser drops the execute bit)', () => {
		expect(TARGETS.find((t) => t.id === 'windows-x64')!.output).toBe(
			'matcami-print-agent-windows-x64.exe'
		);
		for (const t of TARGETS.filter((t) => t.os !== 'windows')) expect(t.output).toMatch(/\.zip$/);
	});
});

describe('buildKey', () => {
	const base = {
		bundleSha: 'a'.repeat(64),
		origin: 'https://pos.example.com',
		nodeVersion: NODE_VERSION,
		scriptVersion: BUILD_SCRIPT_VERSION,
		verified: { macos: false, windows: false }
	};

	it('is stable for the same inputs', () => {
		expect(buildKey(base)).toBe(buildKey({ ...base }));
		expect(buildKey(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	// A flag flipped after a real-machine run must rebuild the manifest on the
	// next deploy, which never passes --force.
	it.each([
		['bundleSha', { bundleSha: 'b'.repeat(64) }],
		['origin', { origin: 'https://other.example.com' }],
		['nodeVersion', { nodeVersion: 'v24.22.0' }],
		['scriptVersion', { scriptVersion: BUILD_SCRIPT_VERSION + 1 }],
		['the macOS flag', { verified: { macos: true, windows: false } }],
		['the Windows flag', { verified: { macos: false, windows: true } }]
	])('changes when %s changes', (_name, over) => {
		expect(buildKey({ ...base, ...over })).not.toBe(buildKey(base));
	});
});
