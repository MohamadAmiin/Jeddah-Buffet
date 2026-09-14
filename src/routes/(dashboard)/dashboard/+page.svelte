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
	const EVENT_TEXT: Record<string, string> = {
		'restaurant.registered': 'Restaurant registered',
		'user.created': 'Account created',
		'login.success': 'Signed in',
		'login.failed': 'Failed sign-in attempt',
		'login.locked_out': 'Account locked after repeated failures',
		'login.rejected_locked': 'Sign-in refused while locked',
		logout: 'Signed out',
		'settings.updated': 'Settings changed',
		'user.password_reset_by_operator': 'Password reset from the command line'
	};

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

<!-- The page band: a raised strip separated from the working column by one
     decorative hairline. h2, not h1 — the layout's h1 is the restaurant name, and
     promoting this would break the document outline on every dashboard screen. -->
<PageHeader
	title="Overview"
	description="Set the restaurant up, then keep it running. This surface is online only — the POS keeps selling when the connection drops, and this one does not pretend to."
/>

<div class="flex max-w-6xl flex-col gap-10 px-4 pt-8 pb-16 lg:px-7">
	<!-- WHAT IS TRUE RIGHT NOW. Every figure below is read from the database or
	     computed from the restaurant's own time zone on this render — none of it is
	     a placeholder, and none of it is money. Takings, covers and stock are the
	     numbers an owner actually wants here, and they are absent on purpose: no
	     order, invoice or stock movement exists yet, and a zero on a dashboard is
	     indistinguishable from a broken query. They arrive with their features. -->
	<section class="flex flex-col gap-4">
		<h3 class="sr-only">At a glance</h3>
		<dl class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<div class="bg-raise border-line rounded-card shadow-flat flex flex-col gap-1 border p-4">
				<dt class="text-eyebrow text-ink-3 uppercase">Local date</dt>
				<dd class="text-section">{localDate}</dd>
				<dd class="text-caption text-ink-2 font-mono tabular-nums">{localTime} · {tz}</dd>
			</div>
			<div class="bg-raise border-line rounded-card shadow-flat flex flex-col gap-1 border p-4">
				<dt class="text-eyebrow text-ink-3 uppercase">Setup</dt>
				<dd class="text-section font-mono tabular-nums">{doneCount} of {steps.length}</dd>
				<dd class="text-caption text-ink-2">steps complete</dd>
			</div>
			<div class="bg-raise border-line rounded-card shadow-flat flex flex-col gap-1 border p-4">
				<dt class="text-eyebrow text-ink-3 uppercase">Recorded events</dt>
				<dd class="text-section font-mono tabular-nums">{data.activity.length}</dd>
				<dd class="text-caption text-ink-2">most recent shown below</dd>
			</div>
			<div class="bg-raise border-line rounded-card shadow-flat flex flex-col gap-1 border p-4">
				<dt class="text-eyebrow text-ink-3 uppercase">Selling</dt>
				<dd class="text-section flex items-center gap-2">
					<!-- Colour never alone: the glyph and the word both say it. -->
					<span aria-hidden="true" class="text-st-offline font-mono">◆</span>
					<span>Not yet</span>
				</dd>
				<dd class="text-caption text-ink-2">no POS session has been opened</dd>
			</div>
		</dl>
	</section>

	<!-- REAL ROWS from the append-only audit log, scoped to this restaurant in the
	     query. `details` never leaves the server: it carries the email a login was
	     tried with and the old and new values of a settings change, and a dashboard
	     has no reason to broadcast either. -->
	<section class="flex flex-col gap-4">
		<div class="flex flex-col gap-2">
			<p class="text-eyebrow text-ink-3 uppercase">Activity</p>
			<h3 class="text-title">What has happened</h3>
			<p class="text-body text-ink-2 max-w-measure">
				Every sensitive action is recorded and none of these rows can be edited or deleted — a
				correction is a new record, never a rewrite.
			</p>
		</div>

		<Card>
			{#if activity.length === 0}
				<p class="text-body text-ink-2">Nothing recorded yet.</p>
			{:else}
				<ul class="divide-line-soft -my-2 flex list-none flex-col divide-y p-0">
					{#each activity as row, i (i)}
						<li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
							<span class="text-body">{row.text}</span>
							<span class="text-caption text-ink-2 flex items-baseline gap-3">
								{#if row.actor}<span>{row.actor}</span>{/if}
								<span class="font-mono tabular-nums">{row.when}</span>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>
	</section>

	<section class="max-w-measure flex flex-col gap-5">
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
