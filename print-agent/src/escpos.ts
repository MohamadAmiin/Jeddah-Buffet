// ESC/POS ENCODING (spec 11; tasks/menu-and-printing T-26; tasks/settings-tax-payments-receipt T-25).
//
// The ONLY place a printer control byte is written in the whole agent. A job
// is text plus four attributes, or an image; this file turns it into the byte
// stream a raw ESC/POS printer on TCP 9100 understands, and it is the second
// wall behind parseJob: a character outside printable ASCII (0x20–0x7E) still
// THROWS here, so text can never carry a command byte, whatever reached us
// over HTTP. An image's bitmap is the ONLY input-derived non-text data, and it
// appears ONLY inside a GS v 0 raster block whose byte count the block's own
// header fixes ((xL + 256·xH) × (yL + 256·yH)). The agent writes that header
// from the printer's configured width and a band height of at most 64 rows,
// never from the bitmap, so on a printer that implements GS v 0 no byte of a
// picture can be read as a command. The drawer pulse and the paper-status
// query stay the only other byte strings, and they are constants — nothing
// composes them from input.
import type { ImageLine, PrintLine } from './server.ts';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** ESC p 0 25 250 — pulse drawer pin 2 for 50 ms on, 500 ms off. */
export const DRAWER_PULSE = Uint8Array.of(ESC, 0x70, 0x00, 0x19, 0xfa);
/** DLE EOT 4 — real-time paper sensor status; the printer answers one byte. */
export const PAPER_STATUS_QUERY = Uint8Array.of(0x10, 0x04, 0x04);

/**
 * Dots in one printed row for each configured column count. Font A is 12 dots
 * wide: 58 mm paper is 32 × 12 = 384, 80 mm paper is 48 × 12 = 576. parseJob
 * (server.ts) checks an image against this, so it refuses what the encoder
 * cannot write.
 */
export const DOTS: Record<32 | 48, number> = { 32: 384, 48: 576 };
export const MAX_IMAGE_HEIGHT_DOTS = 240;
/** Rows per raster block — a conservative band, not a documented limit (RESEARCH.md). */
const BAND_ROWS = 64;
/** GS v 0 m with m = 0 (normal scale); xL xH yL yH and the raster rows follow. */
const RASTER = [GS, 0x76, 0x30, 0x00];

const INIT = [ESC, 0x40];
const CODE_PAGE_PC437 = [ESC, 0x74, 0x00];
const ALIGN: Record<'left' | 'center', number[]> = {
	left: [ESC, 0x61, 0x00],
	center: [ESC, 0x61, 0x01]
};
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const SIZE: Record<'normal' | 'tall' | 'double', number[]> = {
	normal: [GS, 0x21, 0x00],
	tall: [GS, 0x21, 0x01],
	double: [GS, 0x21, 0x11]
};
const FEED_4 = [ESC, 0x64, 0x04];
const CUT_PARTIAL_FEED = [GS, 0x56, 0x42, 0x00];

function textBytes(text: string): number[] {
	const out: number[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? -1;
		if (code < 0x20 || code > 0x7e) {
			throw new Error(
				`escpos: character U+${code.toString(16).padStart(4, '0')} is not printable ASCII`
			);
		}
		out.push(code);
	}
	return out;
}

/**
 * The second wall for an image, with parseJob out of the picture: the exact
 * shape the raster header below will describe, checked again here. The
 * integer check is not redundant — a fractional height (1.5) would give a
 * band header that declares `rows & 0xff` = 1 row while the row loop wrote 2,
 * so bitmap bytes would land OUTSIDE the window the header fixes.
 */
function imageBytes(image: ImageLine['image'], columns: 32 | 48): Uint8Array {
	const { widthDots, heightDots } = image;
	if (!Number.isInteger(widthDots) || !Number.isInteger(heightDots)) {
		throw new Error('escpos: image widthDots and heightDots must be integers');
	}
	if (widthDots % 8 !== 0 || widthDots < 8 || widthDots > DOTS[columns]) {
		throw new Error(
			`escpos: image widthDots ${widthDots} must be a multiple of 8 from 8 to ${DOTS[columns]} on a ${columns}-column printer`
		);
	}
	if (heightDots < 1 || heightDots > MAX_IMAGE_HEIGHT_DOTS) {
		throw new Error(
			`escpos: image heightDots ${heightDots} must be from 1 to ${MAX_IMAGE_HEIGHT_DOTS}`
		);
	}
	const expected = (widthDots / 8) * heightDots;
	const data = Buffer.from(image.bitmap, 'base64');
	if (data.length !== expected) {
		throw new Error(`escpos: image bitmap is ${data.length} bytes; expected ${expected}`);
	}
	return data;
}

/**
 * Initialise, select PC437, then per line. A text line is align, bold, size,
 * the text, LF — exactly as version 1; `columns` does not affect text. An
 * image line is ESC a 0, bold off, normal size, then GS v 0 bands of at most
 * 64 rows, each row padded with zero bytes on both sides to centre the picture
 * on the printer's full width — the agent does not rely on justification for
 * raster data. No LF follows a band: GS v 0 leaves the print position at the
 * start of the line, which is where the next band or text line needs it. And
 * because every text line ends in LF and INIT precedes everything, the print
 * buffer is empty at every image line (Epson: with data in the buffer, m and
 * what follows are processed as normal data). After the last line reset size,
 * bold and align, feed four lines, and cut when asked.
 */
export function encodeJob(
	lines: readonly PrintLine[],
	opts: { cut: boolean; columns: 32 | 48 }
): Uint8Array {
	const bytes: number[] = [...INIT, ...CODE_PAGE_PC437];
	for (const line of lines) {
		if ('image' in line) {
			const image = line.image;
			const data = imageBytes(image, opts.columns);
			bytes.push(...ALIGN.left, ...BOLD_OFF, ...SIZE.normal);
			const full = DOTS[opts.columns] / 8; // bytes in a printed row: 48 or 72
			const row = image.widthDots / 8;
			const padLeft = Math.floor((full - row) / 2);
			const padRight = full - row - padLeft;
			for (let top = 0; top < image.heightDots; top += BAND_ROWS) {
				const rows = Math.min(BAND_ROWS, image.heightDots - top);
				bytes.push(...RASTER, full & 0xff, full >> 8, rows & 0xff, rows >> 8);
				for (let r = top; r < top + rows; r += 1) {
					for (let k = 0; k < padLeft; k += 1) bytes.push(0x00);
					for (let k = 0; k < row; k += 1) bytes.push(data[r * row + k]!);
					for (let k = 0; k < padRight; k += 1) bytes.push(0x00);
				}
			}
			continue;
		}
		bytes.push(...ALIGN[line.align ?? 'left']);
		bytes.push(...(line.bold ? BOLD_ON : BOLD_OFF));
		bytes.push(...SIZE[line.size ?? 'normal']);
		bytes.push(...textBytes(line.text));
		bytes.push(LF);
	}
	bytes.push(...SIZE.normal, ...BOLD_OFF, ...ALIGN.left, ...FEED_4);
	if (opts.cut) bytes.push(...CUT_PARTIAL_FEED);
	return Uint8Array.from(bytes);
}
