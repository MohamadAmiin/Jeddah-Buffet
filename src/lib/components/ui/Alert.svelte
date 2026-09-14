<script lang="ts">
	// A page-level message region. It carries role="alert" so a screen reader
	// announces it without the user going looking — the same reason /login and
	// /settings carry it on their message paragraph today.
	//
	// AT MOST ONE ALERT IS VISIBLE PER PAGE AT A TIME. e2e/auth.spec.ts asserts
	// against a SINGLE page.getByRole('alert') locator, so two visible regions is a
	// Playwright strict-mode violation that fails the run with "resolved to 2
	// elements" — not with anything that looks like a styling problem. Do not add a
	// second standing alert to any screen, and never give this component a variant
	// that renders two regions. (Field's per-field error deliberately does not use
	// this role, for the same reason.)

	let {
		tone = 'info',
		children
	}: {
		tone?: 'info' | 'success' | 'danger';
		children: import('svelte').Snippet;
	} = $props();

	// Tone -> surface, tokens only. Each tone keeps its text on its own -bg ground or
	// on bg-raise, where these inks pass in BOTH themes. In DARK, --c-danger and
	// --c-ok are ILLEGAL on bg-raise-2 (4.06:1 and 4.18:1) and on bg-accent-soft
	// (4.19:1, 4.31:1) — if a pair ever fails, change the PAIR. No task in this plan
	// may fix contrast by editing a colour value; the user deferred palette work.
	const tones = {
		info: 'bg-raise border-line text-ink',
		success: 'bg-ok-bg border-ok text-ok',
		danger: 'bg-danger-bg border-danger text-danger'
	};

	// Colour NEVER carries meaning alone — WCAG 1.4.1, and roughly one man in twelve
	// has red-green colour vision deficiency. The glyph is aria-hidden: the caller's
	// message text carries the meaning and the glyph must not join the announced
	// string.
	const glyphs = { info: '•', success: '✓', danger: '✕' };

	const classes = $derived('rounded-control border px-3 py-2 text-sm ' + tones[tone]);
	const glyph = $derived(glyphs[tone]);
</script>

<div role="alert" class={classes}>
	<span aria-hidden="true" class="font-mono">{glyph}</span>
	{@render children()}
</div>
