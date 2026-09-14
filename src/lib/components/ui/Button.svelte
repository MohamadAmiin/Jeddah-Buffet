<script lang="ts">
	// A DASHBOARD button: seated, mouse-driven, Tailwind's default spacing scale.
	// Never the POS touch tokens (p-touch, min-h-touch-xl, …) — those are 56-96px
	// targets for a standing thumb. See docs/design-system.md section 7b.
	//
	// The accessible name is EXACTLY the children text. Do not render an icon, a
	// spinner, a badge or any other text node inside the button by default:
	// e2e/auth.spec.ts locates every button in the journey by accessible name.

	let {
		variant = 'primary',
		type = 'button',
		disabled = false,
		disabledReason = '',
		href = undefined,
		children,
		...rest
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		type?: 'button' | 'submit' | 'reset';
		disabled?: boolean;
		disabledReason?: string;
		href?: string;
		children: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();

	const uid = $props.id();
	const reasonId = uid + '-reason';

	// $derived, NOT a plain const: in runes mode a top-level const initialiser is
	// evaluated once at setup and then frozen, so the description would never
	// appear or never leave when `disabled` changed.
	const describedBy = $derived(disabled && disabledReason ? reasonId : undefined);

	// A disabled control takes its OWN token pair — NEVER `opacity`. opacity
	// composites the whole element, fill AND ink together, onto whatever is behind
	// it, so it silently defeats every pair tokens.css audits: this button measured
	// 2.70:1 label-on-fill in light and 3.69:1 in dark under disabled:opacity-60,
	// and its fill sat at 2.70:1 against the page, below WCAG 1.4.11's 3:1. The
	// pair below is 5.91:1 light / 6.15:1 dark and is covered by the contrast
	// census. `disabled:` wins over the variant classes because it is declared
	// after them in the string.
	const base =
		'rounded-control px-3 py-2 text-sm font-medium ' +
		'disabled:cursor-not-allowed disabled:border disabled:border-control-line ' +
		'disabled:bg-disabled-bg disabled:text-disabled-ink';

	// primary  6.13:1 light / 7.82:1 dark
	// secondary/ghost/danger draw on the card or page ground, where text-ink and
	// text-danger are both legal. border-control-line is 5.13:1 light / 4.87:1 dark,
	// above WCAG 1.4.11's 3:1 for a control boundary — border-line is 1.58:1 and is
	// decorative only, never a control edge.
	const variants = {
		primary: 'bg-accent text-accent-ink',
		secondary: 'border border-control-line text-ink',
		ghost: 'text-ink hover:bg-raise-2',
		danger: 'border border-danger text-danger'
	};

	const classes = $derived(base + ' ' + variants[variant]);
</script>

{#if href}
	<!-- An <a> has the LINK role, not button: a caller must not use this form where
	     a getByRole('button', …) assertion applies. `type`, `disabled` and
	     `disabledReason` belong to the button form only and are not emitted here.
	     The caller passes an href already produced by resolve() from $app/paths —
	     svelte/no-navigation-without-resolve requires it and lint fails without it.
	     This component neither calls resolve() nor rewrites the value it is given. -->
	<!-- The caller passes an href ALREADY produced by resolve(); the rule cannot see
	     through the prop and would otherwise force this component to re-resolve a value
	     that is already resolved. Disabled on the ONE line below — never globally via
	     ignoreLinks in eslint.config.js, which would switch the rule off at every CALL
	     SITE too, and the call sites are exactly where it needs to fire. -->
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a {href} {...rest} class={classes}>{@render children()}</a>
{:else}
	<button {type} {disabled} aria-describedby={describedBy} {...rest} class={classes}>
		{@render children()}
	</button>
{/if}

{#if disabled && disabledReason}
	<!-- A disabled control must SAY WHY rather than sit dead (design-system 7b).
	     A SIBLING of the button, never inside it: aria-describedby adds a
	     description without changing the accessible NAME. A Svelte component may
	     have several root nodes, so no wrapper is needed. -->
	<span id={reasonId} class="text-ink-2 text-xs">{disabledReason}</span>
{/if}
