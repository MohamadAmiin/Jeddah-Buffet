<script lang="ts">
	import { resolve } from '$app/paths';

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

<h2 class="font-display text-xl font-bold">Getting set up</h2>
<p class="text-ink-2 mt-1 text-sm">
	Work down this list in order. Finish the settings, then add your employees, then build the menu.
</p>

<ol class="mt-4 flex flex-col gap-2">
	{#each steps as step (step.label)}
		<li class="bg-raise border-line rounded border p-3">
			<div class="flex items-start gap-3">
				<!--
					A GLYPH as well as a colour. Colour never carries meaning alone
					(WCAG 1.4.1; roughly one man in twelve has red-green CVD).
				-->
				<span aria-hidden="true" class={step.done ? 'text-ok font-mono' : 'text-ink-3 font-mono'}>
					{step.done ? '●' : '○'}
				</span>
				<div class="min-w-0">
					<p class="text-ink text-sm font-medium">
						{step.label}
						<span class="sr-only">{step.done ? ' — done' : ' — not started'}</span>
						{#if !step.done}
							<span class="text-ink-3 ml-2 text-xs font-normal">not started</span>
						{/if}
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
			</div>
		</li>
	{/each}
</ol>

<!--
	NO MONEY FIGURES AT ALL — not revenue, not today's takings, not a zero. The
	money module does not exist, the UI never does money arithmetic, and a zero on
	a dashboard is indistinguishable from a broken query. Sales reports arrive with
	their own plan and their own formatter.
-->
