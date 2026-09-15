<script lang="ts">
	// A DASHBOARD form field: label, control, hint, error — in that order, inside ONE
	// wrapper element.
	//
	// THE LABEL'S TEXT IS THE CONTROL'S ACCESSIBLE NAME. It renders the `label` prop
	// verbatim and nothing else: no asterisk, no `(required)`, no unit, no marker of
	// any kind inside the <label>. e2e/auth.spec.ts locates SEVEN fields by exact
	// label text, and `getByLabel('Password', { exact: true })` is written to tell
	// `Password` from `Confirm password` — a suffix on either destroys that
	// distinction. Mark required-ness with the `required` attribute on the control.

	let {
		id,
		label,
		name,
		type = 'text',
		value = '',
		required = false,
		hint = '',
		error = '',
		list = undefined,
		autocomplete = undefined,
		minlength = undefined,
		...rest
	}: {
		id: string;
		label: string;
		name: string;
		type?: string;
		value?: string;
		required?: boolean;
		// string | Snippet, deliberately: a hint may need markup — a <code> element,
		// say. Svelte HTML-escapes {hint}, so a plain string prop would render the
		// literal tags on screen. A snippet stays type-checked and escaping-safe.
		// NEVER use {@html} for this.
		hint?: string | import('svelte').Snippet;
		error?: string;
		list?: string;
		// The DOM's own union (FullAutoFill), not `string`: the plan drafted this as
		// string, but <input autocomplete> is a closed set and svelte-check rejects a
		// widened string. Typing it from svelte/elements keeps 'username',
		// 'current-password' and 'new-password' checked instead of merely allowed.
		autocomplete?: import('svelte/elements').HTMLInputAttributes['autocomplete'];
		minlength?: number;
		[key: string]: unknown;
	} = $props();

	const uid = $props.id();
	const hintId = uid + '-hint';
	const errorId = uid + '-err';

	const describedBy = $derived(
		[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
	);

	// border-control-line, NOT border-line: 5.13:1 light and 4.87:1 dark, above WCAG
	// 1.4.11's 3:1 floor for a UI component boundary. border-line measures 1.58:1 on
	// --c-raise and is decorative only — a control whose sole boundary is that line
	// is effectively unbounded, and that is much of why the old screens read washed
	// out.
	const controlClass = 'border-control-line bg-bg text-ink rounded-control border px-3 py-2';
</script>

<!-- ONE wrapper, and it is the whole point. The caller's form is `flex flex-col
     gap-4`, so every Field must arrive as ONE flex child of it; the wrapper's own
     `gap-1` preserves the 4px label-to-control rhythm inside that 16px form gap.
     Four sibling root nodes would instead become four independent children spaced
     16px apart — every label floating a full gap above its input. The caller
     therefore keeps NO grouping div of its own. -->
<div class="flex flex-col gap-1">
	<label for={id} class="text-ink-2 text-sm font-medium">{label}</label>

	<!-- {...rest} before class: a later attribute wins in Svelte, so the class stays
	     token-built whatever a caller passes. -->
	<input
		{id}
		{name}
		{type}
		{value}
		{required}
		{list}
		{autocomplete}
		{minlength}
		aria-describedby={describedBy}
		aria-invalid={error ? 'true' : undefined}
		{...rest}
		class={controlClass}
	/>

	{#if hint}
		<!-- text-ink-3 is legal HERE only because a Field sits inside a bg-raise card:
		     --c-ink-3 is 5.13:1 on --c-raise but only 4.35:1 on --c-bg, below the 4.5:1
		     floor. A Field placed directly on the page ground must not show an ink-3
		     hint — use text-ink-2 (6.38:1 on light bg) there. -->
		<p id={hintId} class="text-ink-3 text-xs">
			{#if typeof hint === 'string'}{hint}{:else if hint}{@render hint()}{/if}
		</p>
	{/if}

	{#if error}
		<!-- No role="alert" here, deliberately. e2e/auth.spec.ts asserts against a
		     SINGLE page.getByRole('alert') locator, and a second alert region is a
		     Playwright strict-mode violation ("resolved to 2 elements"). The page-level
		     Alert owns that role; a field error is associated with its control through
		     aria-describedby and aria-invalid instead. -->
		<p id={errorId} class="text-danger text-sm">{error}</p>
	{/if}
</div>
