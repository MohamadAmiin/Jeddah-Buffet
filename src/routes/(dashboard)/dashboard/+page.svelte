<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		Button,
		Callout,
		Icon,
		PageBody,
		PageHeader,
		StatTile,
		StatusMark
	} from '$lib/components/ui';
	import { EVENT_TEXT } from './event-text';

	let { data } = $props();

	// The real sequence of work. The settings, employees, menu and device steps are
	// computed, because their features exist — the rest are shown as "not started"
	// with one line saying what each will do. Progress is not faked, and nothing
	// links to a route that does not exist.
	const steps = $derived([
		{
			label: 'Restaurant settings',
			done: data.settings.complete,
			href: '/settings',
			cta: 'Open settings',
			detail: data.settings.complete
				? 'Name, time zone, tax and currency are set.'
				: `Still needed: ${data.settings.missing.join(', ')}.`
		},
		{
			label: 'Employees and PINs',
			done: data.employeesReady,
			href: '/employees',
			cta: 'Add employees',
			detail: 'Add at least one staff member with a PIN for the POS.'
		},
		{
			label: 'Menu, categories and modifiers',
			done: data.menuReady,
			href: '/menu',
			cta: 'Open menu',
			detail: data.menuReady
				? 'Your menu has items. Prices and modifiers can be changed at any time.'
				: 'What you sell, what it costs, and the options that change a recipe.'
		},
		{
			label: 'Dining tables',
			done: false,
			href: null,
			detail: 'The floor plan the POS opens orders against.'
		},
		{
			label: 'Register the POS device',
			done: data.deviceRegistered,
			href: '/device',
			cta: 'Open the POS page',
			detail:
				'The till registers itself when the owner signs in on it once; the POS page shows it and can revoke it.'
		},
		{
			label: 'Open the first shift on the till',
			done: false,
			href: null,
			detail: 'Opening cash, sales, count, reconciliation, end-of-day report.'
		}
	]);

	// COUNTED, never written down. "1 of 6" typed as a string is a second source of
	// truth that goes stale the first time a step is added or completed.
	const doneCount = $derived(steps.filter((step) => step.done).length);

	// THE RESTAURANT'S OWN CLOCK, not the browser's. Invariant 11: the date a
	// business day belongs to is decided by the restaurant's time zone, so a screen
	// that reports "today" from the viewer's locale is reporting the wrong day for
	// anyone travelling — and for a 01:30 sale, the wrong day for everyone.
	//
	// This is the LOCAL DATE, and it is deliberately not called the business date.
	// The business date belongs to a POS session, and no session exists yet; naming
	// it here would invent a concept the product has not built.
	const tz = $derived(data.timeZone ?? 'UTC');
	const localDate = $derived(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			weekday: 'long',
			day: 'numeric',
			month: 'long'
		}).format(new Date())
	);
	const localTime = $derived(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date())
	);

	// Audit events are a closed union (src/lib/server/audit/events.ts). Mapping them
	// to sentences here — rather than printing the raw dotted name — keeps the
	// vocabulary in one place, and the `details` payload never leaves the server.
	const activity = $derived(
		data.activity.map((row) => ({
			text: EVENT_TEXT[row.event] ?? row.event,
			actor: row.actor,
			when: new Intl.DateTimeFormat('en-GB', {
				timeZone: tz,
				day: '2-digit',
				month: 'short',
				hour: '2-digit',
				minute: '2-digit'
			}).format(new Date(row.occurredAt))
		}))
	);
</script>

<svelte:head>
	<title>Overview · matcami</title>
</svelte:head>

<!-- The page band: title, description, and the restaurant's local date as a
     header meta chip. h2, not h1 — the layout's h1 is the restaurant name, and
     promoting this would break the document outline on every dashboard screen. -->
<PageHeader
	title="Overview"
	description="Set the restaurant up, then keep it running. This surface is online only — the POS keeps selling when the connection drops, and this one does not pretend to."
>
	{#snippet actions()}
		<p
			class="rounded-control border-line bg-raise-2 text-caption text-ink-2 flex items-center gap-2 border px-3 py-2"
		>
			<Icon name="calendar" class="size-4" />
			<span
				><span class="sr-only">Local date: </span>{localDate} ·
				<span class="font-mono tabular-nums">{localTime}</span> · {tz}</span
			>
		</p>
	{/snippet}
</PageHeader>

<PageBody>
	{#if data.flaggedCount > 0}
		<!-- A STANDING notice: role="status" (Callout owns the glyph), never an alert. -->
		<Callout title={`${data.flaggedCount} sales await your review`}>
			{#snippet action()}
				<Button variant="primary" href={resolve('/reports/flagged')}>
					<Icon name="arrow-right" class="size-4" />Review them
				</Button>
			{/snippet}
		</Callout>
	{/if}

	<!-- WHAT IS TRUE RIGHT NOW. Every figure below is read from the database on
	     this render — none of it is a placeholder, and none of it is money. Takings,
	     covers and stock are absent on purpose: a zero on a dashboard is
	     indistinguishable from a broken query. They arrive with their features. -->
	<section aria-labelledby="glance-h">
		<h3 id="glance-h" class="sr-only">At a glance</h3>
		<dl class="grid gap-3 sm:grid-cols-3">
			<StatTile label="Setup" numeric caption="steps complete">
				{doneCount} of {steps.length}
			</StatTile>
			<StatTile label="Recorded events" numeric caption="most recent shown below">
				{data.activity.length}
			</StatTile>
			<StatTile label="Selling" caption="no shift has been opened on the till">
				<span class="flex items-center gap-2">
					<!-- Colour never alone: the glyph and the word both say it. -->
					<span aria-hidden="true" class="text-st-offline font-mono">◆</span>
					<span>Not yet</span>
				</span>
			</StatTile>
		</dl>
	</section>

	<div class="grid items-start gap-6 xl:grid-cols-5">
		<!-- REAL ROWS from the append-only audit log, scoped to this restaurant in the
		     query. `details` never leaves the server: it carries the email a login was
		     tried with and the old and new values of a settings change, and a
		     dashboard has no reason to broadcast either. -->
		<section
			aria-labelledby="activity-h"
			class="rounded-card border-line bg-raise shadow-card border xl:col-span-3"
		>
			<div
				class="border-line-soft flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b px-6 py-4"
			>
				<div class="flex flex-col gap-1">
					<p class="text-eyebrow text-ink-3 uppercase">Activity</p>
					<h3 id="activity-h" class="text-section">What has happened</h3>
				</div>
				<p class="text-caption text-ink-2 max-w-measure">
					Every sensitive action is recorded and none of these rows can be edited or deleted — a
					correction is a new record, never a rewrite.
				</p>
			</div>
			{#if activity.length === 0}
				<p class="text-body text-ink-2 px-6 py-4">Nothing recorded yet.</p>
			{:else}
				<ul class="divide-line-soft flex list-none flex-col divide-y px-6">
					{#each activity as row, i (i)}
						<li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
							<span class="text-body">{row.text}</span>
							<span class="text-caption text-ink-2 flex items-baseline gap-3">
								{#if row.actor}<span>{row.actor}</span>{/if}
								<span class="font-mono tabular-nums">{row.when}</span>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section
			aria-labelledby="setup-h"
			class="rounded-card border-line bg-raise shadow-card flex flex-col gap-4 border p-6 xl:col-span-2"
		>
			<div class="flex flex-col gap-1">
				<p class="text-eyebrow text-ink-3 uppercase">Onboarding</p>
				<h3 id="setup-h" class="text-section">Getting set up</h3>
				<p class="text-caption text-ink-2">
					Work down this list in order. Finish the settings, then add your employees, then build the
					menu. Nothing below is faked.
				</p>
			</div>

			<!-- PROGRESS IN WORDS FIRST. The count is the signal; the bar repeats it for
			     anyone reading the shape rather than the sentence, and is aria-hidden so
			     a screen reader hears the count once. -->
			<div class="flex items-center gap-3">
				<span aria-hidden="true" class="flex flex-1 gap-1">
					{#each steps as step (step.label)}
						<span class={`h-1.5 flex-1 rounded-full ${step.done ? 'bg-ok' : 'bg-line'}`}></span>
					{/each}
				</span>
				<span class="text-caption text-ink-2 font-mono tabular-nums">
					{doneCount} of {steps.length} done
				</span>
			</div>

			<!-- The <ol> stays so the sequence is exposed as an ordered list. Each step
			     is a plain <li> with a divider: cards do not nest inside cards. -->
			<ol class="divide-line-soft flex flex-col divide-y">
				{#each steps as step (step.label)}
					<li class="flex items-start gap-3 py-3">
						<!--
							A GLYPH as well as a colour (WCAG 1.4.1). StatusMark is passed NO
							label: the screen-reader string and the visible badge below are owned
							by this page and are asserted by the e2e journey.
						-->
						<span
							class={`grid size-7 flex-none place-items-center rounded-full ${step.done ? 'bg-ok-bg' : 'bg-bg-2'}`}
						>
							<StatusMark status={step.done ? 'done' : 'not-started'} />
						</span>
						<div class="flex min-w-0 flex-1 flex-col gap-0.5">
							<div class="flex items-baseline justify-between gap-3">
								<!-- font-sans overrides the base layer's display face: a six-row
								     checklist reads as a list of things to do, not six headings. -->
								<h4 class="text-ink font-sans text-sm font-semibold">
									{step.label}<span class="sr-only"> — {step.done ? 'done' : 'not started'}</span>
								</h4>
								<!--
									The badge is on EVERY step, and aria-hidden: the heading's sr-only
									span already carries the state. The DOM text is the lowercase
									literal `not started` — e2e/auth.spec.ts asserts
									getByText('not started', { exact: true }) resolves to exactly six
									elements on a freshly registered restaurant. `uppercase` changes the
									rendering only.
								-->
								<span
									aria-hidden="true"
									class={`text-eyebrow flex-none font-mono whitespace-nowrap uppercase ${step.done ? 'text-ok' : 'text-ink-2'}`}
									>{step.done ? 'done' : 'not started'}</span
								>
							</div>
							<!-- Its link or its detail: a done step with a link needs no detail;
							     an unfinished one says what is still needed. -->
							{#if !step.done || !step.href}
								<p class="text-caption text-ink-2">{step.detail}</p>
							{/if}
							{#if step.href}
								<!-- The cast is the union of the hrefs the steps array holds, and
								     each linked step carries its own cta. -->
								<a
									href={resolve(step.href as '/settings' | '/employees' | '/menu' | '/device')}
									class="text-caption text-accent self-start font-medium underline underline-offset-2"
								>
									{step.cta}
								</a>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</section>
	</div>
</PageBody>

<!--
	NO MONEY FIGURES AT ALL — not revenue, not today's takings, not a zero. The UI
	never does money arithmetic, and a zero on a dashboard is indistinguishable from
	a broken query. Sales figures live on /reports with their own formatter.
-->
