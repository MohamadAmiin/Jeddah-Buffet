// DRAWING A LINE OF ARABIC (2026-10-25) — BROWSER-ONLY: drawTextLine touches
// document and a canvas; nothing does at import time, so the module is safe to
// import in a Node test.
//
// A thermal printer cannot join Arabic letters or run them right to left, so a
// line that holds Arabic is drawn here as a 1-bit picture and printed like the
// logo. The browser's text engine does the shaping and the ordering, exactly as
// on screen. The picture keeps the receipt's own grid — the line's characters
// each own one column of 12 dots (Font A, as print-agent escpos.ts DOTS: 32
// columns are 384 dots, 48 are 576) — so the amounts on a drawn line stand in
// the same columns as on the printed text lines around it:
// - an ASCII character is drawn centred in its own column, in IBM Plex Mono;
// - an Arabic run (paper-script.ts runs: a phrase, spaces between its words
//   included) is drawn right to left in the columns it owns — from their left
//   edge, or centred in them on a centred line — in IBM Plex Sans Arabic, and
//   squeezed sideways only if it would be wider than those columns.
// `tall` doubles the height; `double` doubles both, with half the columns —
// the printer's own GS ! sizes. A centred line is placed as the printer
// centres a text line (ESC a 1): the whole string, leading spaces included.
//
// Pixels go through the logo converter (receipt-logo.ts toGray, packRows,
// encodeBitmap), with a hard threshold rather than its dithering: text wants
// clean edges. The fonts are self-hosted (pinned @fontsource packages) and the
// build's assets are precached, so drawing works offline.
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import { encodeBitmap, packRows, toGray } from '../receipt-logo';
import { runs } from './paper-script';
import type { ImageLine, ReceiptWidth, TextLine } from './receipt';

/** The family @fontsource/ibm-plex-sans-arabic declares (src/lib/styles/fonts.test.ts checks it). */
export const PAPER_ARABIC_FAMILY = 'IBM Plex Sans Arabic';
/** The family @fontsource/ibm-plex-mono declares — the root layout loads 400 and 500. */
export const PAPER_LATIN_FAMILY = 'IBM Plex Mono';

/** Font A: one column is 12 dots wide (print-agent escpos.ts DOTS). */
export const DOTS_PER_COLUMN = 12;
/** A normal line's picture: about the printer's own line pitch at 203 dpi. */
export const LINE_DOTS = 32;
const BASELINE_DOTS = 23;
const ARABIC_PX = 22;
/** IBM Plex Mono advances 0.6 em, so 20 px fills a 12-dot column. */
const LATIN_PX = 20;
/** A dot darker than this prints black: anti-aliased edges keep thin strokes. */
const INK_THRESHOLD = 160;

export type DrawText = (line: TextLine, width: ReceiptWidth) => Promise<ImageLine['image']>;

/** The picture's size for a line at `width` columns: always the full paper width. */
export function pictureSize(
	line: Pick<TextLine, 'size'>,
	width: ReceiptWidth
): { widthDots: number; heightDots: number; columnDots: number } {
	const wide = line.size === 'double' ? 2 : 1;
	const high = line.size === 'tall' || line.size === 'double' ? 2 : 1;
	return {
		widthDots: width * DOTS_PER_COLUMN,
		heightDots: LINE_DOTS * high,
		columnDots: DOTS_PER_COLUMN * wide
	};
}

async function fontsLoaded(specs: string[], sample: string): Promise<void> {
	const fonts = typeof document === 'undefined' ? undefined : document.fonts;
	if (!fonts) return;
	// A font that cannot load still draws in a fallback face: never a reason to fail.
	await Promise.all(specs.map((spec) => fonts.load(spec, sample).catch(() => [])));
}

/** Draw one text line as a 1-bit picture of the full paper width. */
export const drawTextLine: DrawText = async (line, width) => {
	const { widthDots, heightDots, columnDots } = pictureSize(line, width);
	const wide = columnDots / DOTS_PER_COLUMN;
	const high = heightDots / LINE_DOTS;
	const arabicFont = `${line.bold ? 700 : 500} ${ARABIC_PX * wide}px "${PAPER_ARABIC_FAMILY}"`;
	const latinFont = `${line.bold ? 500 : 400} ${LATIN_PX * wide}px "${PAPER_LATIN_FAMILY}", monospace`;
	await fontsLoaded([arabicFont, latinFont], line.text);

	const canvas = document.createElement('canvas');
	canvas.width = widthDots;
	canvas.height = heightDots;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('This browser cannot draw the Arabic line');
	// Paper and ink, not screen colours: tokens.css governs the UI, not printed dots.
	ctx.fillStyle = 'white';
	ctx.fillRect(0, 0, widthDots, heightDots);
	ctx.fillStyle = 'black';
	ctx.textBaseline = 'alphabetic';

	const length = [...line.text].length;
	const left =
		line.align === 'center' ? Math.max(0, Math.floor((widthDots - length * columnDots) / 2)) : 0;
	const baseline = BASELINE_DOTS * high;
	// The vertical stretch a `tall` line needs once the font is sized for its width.
	const stretch = high / wide;

	for (const run of runs(line.text)) {
		const x = left + run.start * columnDots;
		if (run.arabic) {
			ctx.font = arabicFont;
			ctx.direction = 'rtl';
			ctx.textAlign = 'left';
			const room = [...run.text].length * columnDots;
			const natural = ctx.measureText(run.text).width;
			const squeeze = natural > room ? room / natural : 1;
			// Arabic is narrower than its columns: a centred line centres it in them.
			const inset = line.align === 'center' ? Math.floor((room - natural * squeeze) / 2) : 0;
			ctx.save();
			ctx.translate(x + inset, baseline);
			ctx.scale(squeeze, stretch);
			ctx.fillText(run.text, 0, 0);
			ctx.restore();
			continue;
		}
		ctx.font = latinFont;
		ctx.direction = 'ltr';
		ctx.textAlign = 'center';
		[...run.text].forEach((ch, k) => {
			if (ch === ' ') return;
			ctx.save();
			ctx.translate(x + (k + 0.5) * columnDots, baseline);
			ctx.scale(1, stretch);
			ctx.fillText(ch, 0, 0);
			ctx.restore();
		});
	}

	const gray = toGray(ctx.getImageData(0, 0, widthDots, heightDots).data, widthDots, heightDots);
	const mono = new Uint8Array(gray.length);
	for (let i = 0; i < gray.length; i += 1) mono[i] = gray[i]! < INK_THRESHOLD ? 1 : 0;
	return { widthDots, heightDots, bitmap: encodeBitmap(packRows(mono, widthDots, heightDots)) };
};
