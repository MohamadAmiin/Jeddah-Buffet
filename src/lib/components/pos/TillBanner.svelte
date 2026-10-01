<script lang="ts">
	// THE TILL BANNER — one component for every till notice (docs/redesign Phase 3):
	// pay outcomes, session blockers, PIN and register errors, the offline notice.
	// It draws its own glyph (aria-hidden); callers pass WORDS only, so a glyph is
	// never doubled. Failures use live="alert" (at most one per page); progress and
	// standing notices "status"; a blocker line that a disabled closer points at
	// with aria-describedby uses "off".
	import type { Snippet } from 'svelte';

	let {
		tone,
		live = 'off',
		id,
		testid,
		children
	}: {
		tone: 'ok' | 'pending' | 'offline' | 'danger';
		live?: 'alert' | 'status' | 'off';
		id?: string;
		testid?: string;
		children: Snippet;
	} = $props();

	const TONE = {
		ok: { glyph: '●', cls: 'border-ok bg-ok-bg text-ok' },
		pending: { glyph: '◐', cls: 'border-line bg-raise-2 text-ink' },
		offline: { glyph: '◆', cls: 'border-st-offline bg-st-offline-bg text-st-offline' },
		danger: { glyph: '✕', cls: 'border-danger bg-danger-bg text-danger' }
	} as const;
</script>

<div
	{id}
	data-testid={testid}
	role={live === 'off' ? undefined : live}
	class="rounded-card flex items-start gap-3 border px-4 py-3 {TONE[tone].cls}"
>
	<!-- The trailing space keeps the text "● Paid", not "●Paid". -->
	<span aria-hidden="true" class="font-mono">{`${TONE[tone].glyph} `}</span>
	<div class="min-w-0 flex-1">{@render children()}</div>
</div>
