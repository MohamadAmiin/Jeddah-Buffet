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

	// COUNTED, never written down. "1 of 6" typed as a string is a second source of
	// truth that goes stale the first time a step is added or completed.
	const doneCount = $derived(steps.filter((step) => step.done).length);
</script>

<svelte:head>
	<title>Overview · matcami</title>
</svelte:head>

<!-- The page band: a raised strip separated from the working column by one
     decorative hairline. h2, not h1 — the layout's h1 is the restaurant name, and
     promoting this would break the document outline on every dashboard screen. -->
<PageHeader
	title="Overview"
	description="Set the restaurant up, then keep it running. This surface is online only — the POS keeps selling when the connection drops, and this one does not pretend to."
/>

<div class="max-w-measure flex flex-col gap-10 px-4 pt-8 pb-16 lg:px-7">
	<section class="flex flex-col gap-5">
		<div class="flex flex-col gap-2">
			<p class="text-eyebrow text-ink-3 uppercase">Onboarding</p>
			<h3 class="text-title">Getting set up</h3>
			<p class="text-body text-ink-2">
				Work down this list in order. Finish the settings, then add your employees, then build the
				menu. Nothing below is faked: only the first step can be checked, because only its feature
				exists.
			</p>
		</div>

		<!-- PROGRESS IN WORDS FIRST. The count is the signal; the bar repeats it for
		     anyone reading the shape rather than the sentence, and is aria-hidden so a
		     screen reader hears the count once. Colour never carries meaning alone. -->
		<div class="flex flex-wrap items-center gap-3">
			<span aria-hidden="true" class="flex gap-1">
				{#each steps as step (step.label)}
					<span class={`h-1.5 w-9 rounded-full ${step.done ? 'bg-ok' : 'bg-line'}`}></span>
				{/each}
			</span>
			<span class="text-caption text-ink-2 font-mono tabular-nums">
				{doneCount} of {steps.length} done
			</span>
		</div>

		<!-- ONE Card holding the rows. Cards do not nest inside cards, so each step is
		     a plain <li> with a divider, not a second Card. The <ol> stays so the
		     sequence is exposed as an ordered list. -->
		<Card>
			<ol class="divide-line-soft flex flex-col divide-y">
				{#each steps as step (step.label)}
					<li class="flex items-start gap-3.5 py-4 first:pt-0 last:pb-0">
						<!--
							A GLYPH as well as a colour. Colour never carries meaning alone
							(WCAG 1.4.1; roughly one man in twelve has red-green CVD). StatusMark
							is passed NO label: the screen-reader string and the visible badge
							below are owned by this page and are asserted by the e2e journey. The
							chip around it is this page's layout, not StatusMark's business.
						-->
						<span
							class={`grid size-7 flex-none place-items-center rounded-full ${step.done ? 'bg-ok-bg' : 'bg-bg-2'}`}
						>
							<StatusMark status={step.done ? 'done' : 'not-started'} />
						</span>
						<div class="flex min-w-0 flex-col gap-0.5">
							<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
								<!-- font-sans overrides the base layer's display face: a six-row
								     checklist reads as a list of things to do, not as six headings. -->
								<h4 class="text-section text-ink font-sans">
									{step.label}<span class="sr-only"> — {step.done ? 'done' : 'not started'}</span>
								</h4>
								<!--
									aria-hidden, and it must stay that way: the heading's sr-only span
									already carries the state, so an announced badge would say it twice.
									The DOM text is the lowercase literal `not started` — e2e/auth.spec.ts
									asserts getByText('not started', { exact: true }) resolves to exactly
									five elements. `uppercase` changes the rendering only; a capitalised
									string in the markup would break the count.
								-->
								<span
									aria-hidden="true"
									class={`text-eyebrow font-mono whitespace-nowrap uppercase ${step.done ? 'text-ok' : 'text-ink-2'}`}
									>{step.done ? 'done' : 'not started'}</span
								>
							</div>
							<p class="text-caption text-ink-2">{step.detail}</p>
							{#if step.href}
								<a
									href={resolve(step.href as '/settings')}
									class="text-caption text-accent mt-1 self-start font-medium underline underline-offset-2"
								>
									Open settings
								</a>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</Card>
	</section>
</div>

<!--
	NO MONEY FIGURES AT ALL — not revenue, not today's takings, not a zero. The
	money module does not exist, the UI never does money arithmetic, and a zero on
	a dashboard is indistinguishable from a broken query. Sales reports arrive with
	their own plan and their own formatter.
-->
