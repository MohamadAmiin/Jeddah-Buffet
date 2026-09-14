<script lang="ts">
	import { resolve } from '$app/paths';
	import { Card, PageHeader, StatusMark } from '$lib/components/ui';

	let { data } = $props();

	// The real sequence of work. Only the first is computable, because only its
	// feature exists — the rest are shown as "not started" with one line saying
	// what each will do. Progress is not faked, and nothing links to a route that
	// does not exist.
	const steps = $derived([
		{
			label: 'Restaurant settings',
			done: data.settings.complete,
			href: '/settings',
			detail: data.settings.complete
				? 'Name and time zone are set.'
				: `Still needed: ${data.settings.missing.join(', ')}.`
		},
		{
			label: 'Employees and PINs',
			done: false,
			href: null,
			detail: 'Add the cashier and waiter, each with a PIN for the POS.'
		},
		{
			label: 'Menu, categories and modifiers',
			done: false,
			href: null,
			detail: 'What you sell, what it costs, and the options that change a recipe.'
		},
		{
			label: 'Dining tables',
			done: false,
			href: null,
			detail: 'The floor plan the POS opens orders against.'
		},
		{
			label: 'Register the POS device',
			done: false,
			href: null,
			detail: 'Only a registered device may show the PIN screen.'
		},
		{
			label: 'Open the first POS session',
			done: false,
			href: null,
			detail: 'Opening cash, sales, count, reconciliation, end-of-day report.'
		}
	]);
</script>

<svelte:head>
	<title>Overview · matcami</title>
</svelte:head>

<!-- level={2}: the (dashboard) layout's h1 is the restaurant name, and promoting
     this to a second h1 would break the document outline. -->
<PageHeader
	level={2}
	title="Getting set up"
	description="Work down this list in order. Finish the settings, then add your employees, then build the menu."
/>

<!-- ONE Card holding the rows. Cards do not nest inside cards, so each step is a
     plain <li> with a divider, not a second Card. The <ol> stays so the sequence is
     exposed as an ordered list. Every text-ink-3 below sits on this card's bg-raise
     ground, where it measures 5.13:1 light and 4.87:1 dark — on the bg-bg page
     ground it would be 4.35:1 and illegal. -->
<Card class="mt-4">
	<ol class="divide-line flex flex-col divide-y">
		{#each steps as step (step.label)}
			<li class="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
				<!--
					A GLYPH as well as a colour. Colour never carries meaning alone
					(WCAG 1.4.1; roughly one man in twelve has red-green CVD). StatusMark
					is passed NO label: the screen-reader string and the visible badge
					below are owned by this page and are asserted by the e2e journey.
				-->
				<StatusMark status={step.done ? 'done' : 'not-started'} />
				<div class="min-w-0">
					<p class="text-ink text-sm font-medium">
						{step.label}
						<span class="sr-only">{step.done ? ' — done' : ' — not started'}</span>
						{#if !step.done}<span class="text-ink-3 ml-2 text-xs font-normal">not started</span
							>{/if}
					</p>
					<p class="text-ink-2 mt-0.5 text-sm">{step.detail}</p>
					{#if step.href}
						<a
							href={resolve(step.href as '/settings')}
							class="text-accent mt-1 inline-block text-sm underline"
						>
							Open settings
						</a>
					{/if}
				</div>
			</li>
		{/each}
	</ol>
</Card>

<!--
	NO MONEY FIGURES AT ALL — not revenue, not today's takings, not a zero. The
	money module does not exist, the UI never does money arithmetic, and a zero on
	a dashboard is indistinguishable from a broken query. Sales reports arrive with
	their own plan and their own formatter.
-->
