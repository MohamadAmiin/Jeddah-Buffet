// ESC/POS ENCODING (spec 11; tasks/menu-and-printing T-26).
//
// The ONLY place a printer control byte is written in the whole agent. A job
// is text plus four attributes; this file turns it into the byte stream a raw
// ESC/POS printer on TCP 9100 understands, and it is the second wall behind
// parseJob: a character outside printable ASCII (0x20–0x7E) THROWS here, so
// text can never carry a command byte, whatever reached us over HTTP. The
// drawer pulse and the paper-status query are the two other byte strings, and
// they are constants — nothing composes them from input.
import type { PrintLine } from './server.ts';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** ESC p 0 25 250 — pulse drawer pin 2 for 50 ms on, 500 ms off. */
export const DRAWER_PULSE = Uint8Array.of(ESC, 0x70, 0x00, 0x19, 0xfa);
/** DLE EOT 4 — real-time paper sensor status; the printer answers one byte. */
export const PAPER_STATUS_QUERY = Uint8Array.of(0x10, 0x04, 0x04);

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
 * Initialise, select PC437, then per line: align, bold, size, the text, LF.
 * After the last line reset size, bold and align, feed four lines, and cut
 * when asked.
 */
export function encodeJob(lines: readonly PrintLine[], opts: { cut: boolean }): Uint8Array {
	const bytes: number[] = [...INIT, ...CODE_PAGE_PC437];
	for (const line of lines) {
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
