// The class strings every till key repeats (docs/redesign Phase 0). Route files
// and till components import these instead of re-typing them; Tailwind v4 scans
// .ts files, so the utilities are still generated.
//
// Every pressable till surface keeps a drawn edge (border-control-line): a white
// key on the till ground is 1.12:1, so elevation alone cannot carry a control's
// boundary (WCAG 1.4.11). Disabled is the token pair, never opacity.

/** A till key: the edge, the face, and the disabled pair. */
export const KEY =
	'rounded-control border border-control-line bg-raise font-semibold disabled:bg-disabled-bg disabled:text-disabled-ink';

/** The chosen state of a radio or pressed key. Colour never carries it alone: the
 * caller adds a check or check-circle icon to the chosen key. */
export const KEY_CHOSEN =
	'aria-checked:border-accent aria-checked:bg-accent aria-checked:text-accent-ink aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-ink';

/** A till text field. */
export const TILL_FIELD = 'min-h-touch rounded-control border border-control-line bg-raise px-3';
