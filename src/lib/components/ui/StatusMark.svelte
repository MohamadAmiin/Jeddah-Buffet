<script lang="ts">
	// A status rendered as a GLYPH plus a colour plus caller-supplied text — never
	// colour alone (CLAUDE.md "Design & UI"; WCAG 1.4.1).
	//
	// Dashboard vocabulary:
	// ● done/active
	// ○ not started/inactive
	// ✕ blocked (locked, archived)
	//
	// Spec 13's item and order statuses still arrive with the orders plan.

	let {
		status,
		label = ''
	}: {
		status: 'done' | 'not-started' | 'blocked';
		label?: string;
	} = $props();

	// text-ink-3 is legal here because the onboarding steps render inside bg-raise
	// cards: --c-ink-3 is 5.13:1 on --c-raise against 4.35:1 on --c-bg, and the
	// 4.5:1 floor is CLAUDE.md's non-negotiable.
	const marks = {
		done: { glyph: '●', tone: 'text-ok' },
		'not-started': { glyph: '○', tone: 'text-ink-3' },
		blocked: { glyph: '✕', tone: 'text-danger' }
	};

	const mark = $derived(marks[status]);
</script>

<!-- The glyph is aria-hidden and monospaced so it aligns down a column. The MEANING
     is carried by whatever visible or screen-reader text the CALLER supplies — this
     component bakes in no wording, and renders no label when `label` is empty. A
     default of 'not started' here would change
     getByText('not started', { exact: true }) from 5 to 10 and break the journey. -->
<span class={mark.tone}
	><span aria-hidden="true" class="font-mono">{mark.glyph}</span>{#if label}&nbsp;{label}{/if}</span
>
