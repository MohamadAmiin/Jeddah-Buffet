<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { Action } from 'svelte/action';
	import {
		ActionBar,
		Alert,
		Button,
		Card,
		CheckField,
		Field,
		PageBody,
		PageColumns,
		PageHeader
	} from '$lib/components/ui';
	import {
		RECEIPT_LINES_PER_SECTION,
		RECEIPT_SHOW_KEYS,
		type ReceiptShow
	} from '$lib/receipt-layout';
	import { decodeBitmap, encodeBitmap, readLogoFile, unpackRows } from '$lib/receipt-logo';
	import {
		isImageLine,
		renderReceipt,
		type ImageLine,
		type PrintLine,
		type ReceiptWidth
	} from '$lib/pos/receipt';
	import { settingsSections, SETTINGS_SECTION_LINK } from '../sections';

	// THE RECEIPT PAGE (tasks/settings-tax-payments-receipt T-31): the header
	// text, the lines, the switches, the heading and the logo, with a live preview
	// drawn by the till's OWN formatter, renderReceipt, from a sample sale the
	// load built through the money module. NOTHING HERE COMPUTES OR ROUNDS A
	// FIGURE (invariants 1, 7): the page prints the sample's stored strings; the
	// integration test's tripwire scans this file for the money helpers by name.

	let { data, form } = $props();
	let submitting = $state(false);

	// Every action returns a `message` on BOTH paths — success, or fail(400). The
	// tone follows the outcome: page.status is 400 after a fail() and 200 otherwise.
	const tone = $derived(page.status === 200 ? 'success' : 'danger');

	// Which form produced `form`, so its outcome renders where that form is: the
	// save in the ActionBar, the logo actions in the logo card (the roles page's
	// idiom). With JavaScript the enhance callback records the action; without
	// it, the POST lands on this URL with the action as the search.
	let submitted = $state<string | null>(null);
	const lastAction = $derived(submitted ?? page.url.search);
	function track({ action }: { action: URL }) {
		submitted = action.search;
	}

	// AT MOST ONE Alert is visible at a time: the two conditions are mutually
	// exclusive by construction. The e2e suite reads a single page.getByRole('alert').
	const hasResult = $derived(form?.message !== undefined);
	const logoResult = $derived(
		hasResult && (lastAction === '?/logo' || lastAction === '?/removeLogo')
	);
	// The save's result, and a no-JavaScript submit that names no action.
	const saveResult = $derived(hasResult && !logoResult);

	const SECTION = 'border-line grid gap-4 border-b pb-8 lg:grid-cols-3 lg:gap-8';
	const FIELDS =
		'bg-raise border-line shadow-card rounded-card grid gap-4 border p-6 md:grid-cols-2 lg:col-span-2';

	/** The nine switches, in RECEIPT_SHOW_KEYS order (gate decision 4). */
	const SHOW_LABELS: Record<keyof ReceiptShow, string> = {
		cashier: 'Print the cashier',
		table: 'Print the table',
		businessDate: 'Print the business date',
		orderType: 'Print the order type',
		unitPrice: 'Print the price each (@ each)',
		currencyLine: 'Print the currency line (All amounts in …)',
		deviceLine: 'Print the till line (matcami POS and the till code)',
		paymentNumbers: 'Print the payment numbers',
		taxBreakdown: 'Print tax per rate when a receipt mixes rates'
	};
	const LINE_SLOTS = Array.from({ length: RECEIPT_LINES_PER_SECTION }, (_, i) => i + 1);

	// THE DRAFT: what the form holds right now, as the writers would store it
	// (lines trimmed and blanks dropped, blank text null), so the preview shows
	// the receipt the owner is about to save. Null until the owner edits — the
	// preview then follows the saved data.
	type Draft = {
		address: string | null;
		phone: string | null;
		taxRegistrationNumber: string | null;
		headerLines: string[];
		footerLines: string[];
		show: ReceiptShow;
		paymentNumbersHeading: string | null;
	};
	function blankToNull(value: string): string | null {
		const trimmed = value.trim();
		return trimmed === '' ? null : trimmed;
	}
	/** The writer's rule (replaceReceiptLines): trim each line, drop the blank ones. */
	function cleanLines(values: string[]): string[] {
		return values.map((value) => value.trim()).filter((value) => value !== '');
	}
	function draftFrom(saved: typeof data): Draft {
		return {
			address: blankToNull(saved.address),
			phone: blankToNull(saved.phone),
			taxRegistrationNumber: blankToNull(saved.taxRegistrationNumber),
			headerLines: [...saved.layout.headerLines],
			footerLines: [...saved.layout.footerLines],
			show: { ...saved.layout.show },
			paymentNumbersHeading: saved.layout.paymentNumbersHeading
		};
	}
	let draft = $state<Draft | null>(null);
	const layoutDraft = $derived(draft ?? draftFrom(data));

	// ONE handler for input and change on the form: it reads the whole form as
	// FormData, exactly as the action will.
	function refreshDraft(event: Event & { currentTarget: EventTarget & HTMLFormElement }) {
		const fields = new FormData(event.currentTarget);
		const strings = (name: string) =>
			fields.getAll(name).filter((value): value is string => typeof value === 'string');
		const text = (name: string) => {
			const value = fields.get(name);
			return typeof value === 'string' ? value : '';
		};
		const shown = new Set(strings('show'));
		draft = {
			address: blankToNull(text('receiptAddress')),
			phone: blankToNull(text('receiptPhone')),
			taxRegistrationNumber: blankToNull(text('taxRegistrationNumber')),
			headerLines: cleanLines(strings('headerLines')),
			footerLines: cleanLines(strings('footerLines')),
			show: Object.fromEntries(
				RECEIPT_SHOW_KEYS.map((key) => [key, shown.has(key)])
			) as ReceiptShow,
			paymentNumbersHeading: blankToNull(text('paymentNumbersHeading'))
		};
	}

	// A saved section is trimmed, its blank lines dropped and the rest renumbered
	// 1..n, so a slot can now hold a different line. Svelte re-sets an input only
	// when its value changes: a slot whose stored value stayed '' would keep the
	// text typed into it and show that line twice — and the next save would store
	// it twice. Bumped after every successful save, it re-creates the ten line
	// fields from the saved layout.
	let savedLines = $state(0);

	// reset: false — a reset would put the fields back as first rendered, and the
	// switches would snap away from the values the owner just saved.
	const keepValues: SubmitFunction = (input) => {
		submitting = true;
		track(input);
		return async ({ result, update }) => {
			await update({ reset: false });
			submitting = false;
			if (result.type === 'success') savedLines += 1;
		};
	};

	// THE LOGO. The file is converted in the browser (readLogoFile, T-30) into
	// plain 1-bit pixel data, and the three hidden fields carry it to ?/logo. The
	// draft is cleared once a logo action succeeds: the preview then shows the
	// saved logo, and Save logo waits for the next file.
	let fileInput = $state<HTMLInputElement | null>(null);
	let draftLogo = $state.raw<ImageLine['image'] | null>(null);
	let logoError = $state('');
	let converting = $state(false);

	async function logoChanged(event: Event & { currentTarget: EventTarget & HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		draftLogo = null;
		logoError = '';
		if (!file) return;
		converting = true;
		try {
			const { widthDots, heightDots, bitmap } = await readLogoFile(file);
			draftLogo = { widthDots, heightDots, bitmap: encodeBitmap(bitmap) };
		} catch (err) {
			logoError = err instanceof Error ? err.message : 'That image could not be read.';
		} finally {
			converting = false;
		}
	}

	const logoSubmit: SubmitFunction = (input) => {
		track(input);
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') {
				draftLogo = null;
				logoError = '';
				if (fileInput) fileInput.value = '';
			}
		};
	};

	// THE PREVIEW: the till's own renderReceipt over the load's sample sale, the
	// draft layout, the current payment numbers and the logo about to print.
	let previewWidth = $state<ReceiptWidth>(48);
	const PREVIEW_ERROR = 'The preview could not be drawn.';
	const preview = $derived.by((): { lines: PrintLine[]; error: string } => {
		const sale = data.sample;
		if (sale === null) return { lines: [], error: '' };
		try {
			return {
				lines: renderReceipt(
					{
						sale,
						header: {
							restaurantName: data.restaurantName,
							address: layoutDraft.address,
							phone: layoutDraft.phone,
							taxRegistrationNumber: layoutDraft.taxRegistrationNumber
						},
						timeZone: data.timeZone ?? 'UTC',
						deviceCode: 'POS1',
						layout: {
							headerLines: layoutDraft.headerLines,
							footerLines: layoutDraft.footerLines,
							show: layoutDraft.show,
							paymentNumbersHeading: layoutDraft.paymentNumbersHeading,
							logo: data.layout.logo
						},
						paymentNumbers: data.paymentNumbers,
						logo: draftLogo ?? data.logo
					},
					{ width: previewWidth }
				),
				error: ''
			};
		} catch {
			return { lines: [], error: PREVIEW_ERROR };
		}
	});

	// A printer column is 12 dots wide (384 dots at 32 columns, 576 at 48), so a
	// logo's share of the paper is widthDots / 12 character cells — the `ch` unit
	// of the tape's monospace font. Pixel geometry, not money.
	const DOTS_PER_COLUMN = 12;

	/** Paints the 1-bit rows onto the canvas: 1 = black, 0 = white. */
	const drawLogo: Action<HTMLCanvasElement, ImageLine['image']> = (canvas, image) => {
		const paint = (next: ImageLine['image']) => {
			canvas.width = next.widthDots;
			canvas.height = next.heightDots;
			const context = canvas.getContext('2d');
			if (!context) return;
			const mono = unpackRows(decodeBitmap(next.bitmap), next.widthDots, next.heightDots);
			const pixels = context.createImageData(next.widthDots, next.heightDots);
			for (let i = 0; i < mono.length; i += 1) {
				const value = mono[i] === 1 ? 0 : 255;
				const offset = i * 4;
				pixels.data[offset] = value;
				pixels.data[offset + 1] = value;
				pixels.data[offset + 2] = value;
				pixels.data[offset + 3] = 255;
			}
			context.putImageData(pixels, 0, 0);
		};
		paint(image);
		return { update: paint };
	};
</script>

<svelte:head>
	<title>Receipt · matcami</title>
</svelte:head>

<PageHeader
	eyebrow="Setup"
	title="Receipt"
	description="What every receipt prints beside the sale itself: the header, up to five lines above and below, the optional details, the payment numbers and a logo. The preview is drawn by the till's own formatter."
>
	{#snippet below()}
		<!-- The settings sub-navigation (gate decision 8). EXACT match only: every
		     /settings/<page> starts with /settings/, so a prefix rule would light
		     General on all four pages. -->
		<nav aria-label="Settings sections" class="-mb-4 flex flex-wrap gap-x-6 gap-y-1 lg:-mb-5">
			{#each settingsSections() as link (link.href)}
				{@const here = page.url.pathname === link.href}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- every href above is a resolve() result -->
				<a
					href={link.href}
					class={SETTINGS_SECTION_LINK}
					aria-current={here ? 'page' : undefined}
					data-current={here ? '' : undefined}>{link.label}</a
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{/each}
		</nav>
	{/snippet}
</PageHeader>

<PageBody>
	<!-- The DEFAULT PageColumns, not `collapsible`: that variant is documented as
	     create-panels-only, and the preview is not a create panel. -->
	<PageColumns>
		<form
			id="receipt-form"
			method="POST"
			action="?/save"
			class="flex flex-col gap-8"
			oninput={refreshDraft}
			onchange={refreshDraft}
			use:enhance={keepValues}
		>
			<section aria-labelledby="s-header" class={SECTION}>
				<div class="flex flex-col gap-1">
					<h3 id="s-header" class="text-section">Header</h3>
					<p class="text-body text-ink-2">
						Printed under the restaurant's name at the top of every receipt.
					</p>
				</div>
				<div class={FIELDS}>
					<Field
						id="receiptAddress"
						name="receiptAddress"
						label="Address"
						maxlength={120}
						value={data.address}
					/>
					<Field
						id="receiptPhone"
						name="receiptPhone"
						label="Phone"
						maxlength={40}
						inputmode="tel"
						value={data.phone}
					/>
					<Field
						id="taxRegistrationNumber"
						name="taxRegistrationNumber"
						label="Tax registration number"
						maxlength={40}
						value={data.taxRegistrationNumber}
						hint="Printed on every receipt when set; it cannot be hidden."
					/>
					{#key savedLines}
						{#each LINE_SLOTS as n (n)}
							<Field
								id={`header-line-${n}`}
								name="headerLines"
								label={`Header line ${n}`}
								maxlength={120}
								value={data.layout.headerLines[n - 1] ?? ''}
							/>
						{/each}
					{/key}
				</div>
			</section>

			<section aria-labelledby="s-footer" class={SECTION}>
				<div class="flex flex-col gap-1">
					<h3 id="s-footer" class="text-section">Footer</h3>
					<p class="text-body text-ink-2">Printed after the payment, before the receipt is cut.</p>
				</div>
				<div class={FIELDS}>
					{#key savedLines}
						{#each LINE_SLOTS as n (n)}
							<Field
								id={`footer-line-${n}`}
								name="footerLines"
								label={`Footer line ${n}`}
								maxlength={120}
								value={data.layout.footerLines[n - 1] ?? ''}
							/>
						{/each}
					{/key}
				</div>
			</section>

			<!-- The nine switches are the COMPLETE hideable set (gate decision 4,
			     CLAUDE.md "Settings 4"); the formatter enforces what never hides. -->
			<section aria-labelledby="s-prints" class={SECTION}>
				<div class="flex flex-col gap-1">
					<h3 id="s-prints" class="text-section">What prints</h3>
					<p class="text-body text-ink-2">The optional details. Untick one to leave it off.</p>
				</div>
				<div class={FIELDS}>
					<fieldset class="flex flex-col gap-3 md:col-span-2">
						<legend class="text-ink-2 text-sm font-medium">Optional lines</legend>
						{#each RECEIPT_SHOW_KEYS as key (key)}
							<CheckField
								id={`show-${key}`}
								name="show"
								value={key}
								label={SHOW_LABELS[key]}
								checked={data.layout.show[key]}
							/>
						{/each}
					</fieldset>
					<p class="text-ink-2 text-sm md:col-span-2">
						Always printed: the restaurant's name, the invoice number, the date and time, the items,
						subtotal, discount, tax and total, the payment, COPY on a reprint, and the tax
						registration number when one is set.
					</p>
				</div>
			</section>

			<!-- The payment-numbers block (Settings 6): the numbers themselves are set
			     per method on /settings/payments; only the heading lives here. -->
			<section aria-labelledby="s-numbers" class={SECTION}>
				<div class="flex flex-col gap-1">
					<h3 id="s-numbers" class="text-section">Payment numbers</h3>
					<p class="text-body text-ink-2">
						Each enabled method's merchant number, printed on every receipt so a customer knows
						where to send money.
					</p>
				</div>
				<div class={FIELDS}>
					<Field
						id="paymentNumbersHeading"
						name="paymentNumbersHeading"
						label="Payment numbers heading"
						maxlength={40}
						value={data.layout.paymentNumbersHeading ?? ''}
						hint="Printed above the numbers. Leave blank for no heading."
					/>
					<div class="flex flex-col gap-2">
						<p class="text-ink-2 text-sm font-medium">Numbers that print</p>
						{#if data.paymentNumbers.length > 0}
							<ul class="flex flex-col gap-1">
								{#each data.paymentNumbers as entry (entry.name)}
									<!-- Name and number in font-mono, as the receipt prints them. -->
									<li class="flex flex-wrap justify-between gap-3 font-mono text-sm">
										<span>{entry.name}</span>
										<span class="tabular-nums">{entry.number}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="text-ink-2 text-sm">No method has a number yet.</p>
						{/if}
						<a
							href={resolve('/settings/payments')}
							class="text-accent text-sm font-medium underline underline-offset-2"
						>
							Edit numbers on Payments
						</a>
					</div>
				</div>
			</section>
		</form>

		<!-- The logo, OUTSIDE the main form — forms cannot nest. The file never
		     leaves the browser as a file: readLogoFile turns it into 1-bit pixel
		     rows, and the hidden fields carry those (risk 6). -->
		<Card class="flex flex-col gap-4">
			<div class="flex flex-col gap-1">
				<h3 class="text-section">Logo</h3>
				<p class="text-body text-ink-2">
					Printed in black and white at the top of every receipt. The till prints it only after its
					test page has shown it correctly.
				</p>
			</div>

			{#if logoResult}
				<Alert {tone}>{form?.message}</Alert>
			{/if}

			<div class="flex flex-col gap-1">
				<label for="logo-file" class="text-ink-2 text-sm font-medium">Logo image</label>
				<input
					id="logo-file"
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
					class="text-ink"
					aria-describedby="logo-file-hint"
					bind:this={fileInput}
					onchange={logoChanged}
				/>
				<p id="logo-file-hint" class="text-ink-3 text-xs">
					Printed in black and white at the top of every receipt, at most 384 × 160 dots. Needs
					print agent version 2 on the till PC — check it with Test print on the till's Printer
					page.
				</p>
				{#if converting}
					<p class="text-ink-2 text-sm">Converting…</p>
				{:else if logoError}
					<p class="text-danger text-sm">✕ {logoError}</p>
				{:else if draftLogo}
					<p class="text-ink-2 text-sm">
						● Ready to save: {draftLogo.widthDots} × {draftLogo.heightDots} dots. The preview shows it.
					</p>
				{:else if data.logo}
					<p class="text-ink-2 text-sm">
						● Current logo: {data.logo.widthDots} × {data.logo.heightDots} dots.
					</p>
				{:else}
					<p class="text-ink-2 text-sm">○ No logo.</p>
				{/if}
			</div>

			<div class="flex flex-wrap gap-3">
				<form method="POST" action="?/logo" use:enhance={logoSubmit}>
					<input type="hidden" name="widthDots" value={draftLogo?.widthDots ?? ''} />
					<input type="hidden" name="heightDots" value={draftLogo?.heightDots ?? ''} />
					<input type="hidden" name="bitmap" value={draftLogo?.bitmap ?? ''} />
					<Button
						type="submit"
						disabled={draftLogo === null}
						disabledReason="Choose an image first."
					>
						Save logo
					</Button>
				</form>
				<form method="POST" action="?/removeLogo" use:enhance={logoSubmit}>
					<Button
						type="submit"
						variant="danger"
						disabled={data.logo === null}
						disabledReason="There is no logo."
					>
						Remove logo
					</Button>
				</form>
			</div>
		</Card>

		{#snippet aside()}
			<Card class="flex flex-col gap-4">
				<div class="flex flex-col gap-1">
					<h3 class="text-section">Preview</h3>
					<p class="text-body text-ink-2">
						A sample sale through the till's own formatter, with what the form holds now.
					</p>
				</div>

				<div class="flex flex-wrap gap-2" role="group" aria-label="Preview width">
					<Button
						type="button"
						aria-pressed={previewWidth === 48}
						onclick={() => (previewWidth = 48)}
					>
						48 columns
					</Button>
					<Button
						type="button"
						aria-pressed={previewWidth === 32}
						onclick={() => (previewWidth = 32)}
					>
						32 columns
					</Button>
				</div>

				{#if data.previewBlocked}
					<p class="text-ink-2 text-sm">○ {data.previewBlocked}</p>
				{:else if preview.error}
					<p class="text-danger text-sm">✕ {preview.error}</p>
				{:else}
					<!-- The tape: every text line is a whitespace-pre div, so the full-width
					     rule lines make the box exactly 32 or 48 characters wide with no width
					     token. Plex Mono has no heavier weight, so bold is font-medium. The
					     wrapper scrolls the tape inside itself on a narrow screen; the page
					     never scrolls horizontally. -->
					<div class="max-w-full overflow-x-auto">
						<div class="bg-raise border-line w-fit border p-4 font-mono text-xs">
							{#each preview.lines as line, i (i)}
								{#if isImageLine(line)}
									<!-- The name sits on a wrapper: Svelte's a11y rule refuses
									     role="img" on the <canvas> itself. -->
									<div role="img" aria-label="The logo">
										<canvas
											width={line.image.widthDots}
											height={line.image.heightDots}
											class="mx-auto block h-auto max-w-full"
											style:width="{line.image.widthDots / DOTS_PER_COLUMN}ch"
											aria-hidden="true"
											use:drawLogo={line.image}
										></canvas>
									</div>
								{:else}
									<div class="whitespace-pre {line.bold ? 'font-medium' : ''}">
										{line.text === '' ? ' ' : line.text}
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/if}
			</Card>
		{/snippet}
	</PageColumns>
</PageBody>

<ActionBar caption="Saved immediately. A till picks it up the next time it loads the staff list.">
	{#snippet message()}
		{#if saveResult}
			<!-- EXACTLY ONE role="alert" may be visible on this page at a time. The
			     journey asserts against a single page.getByRole('alert') locator, so a
			     second region is a Playwright strict-mode violation failing with
			     "resolved to 2 elements" — which looks nothing like a styling problem.
			     The logo card's alert and this one never show together: each is keyed
			     on the action that produced the result. -->
			<Alert {tone}>{form?.message}</Alert>
		{:else}
			<p class="text-caption text-ink-2">
				Saved immediately. A till picks it up the next time it loads the staff list.
			</p>
		{/if}
	{/snippet}

	<!-- The label says WHY it is disabled while a save is in flight. -->
	<Button type="submit" form="receipt-form" variant="primary" disabled={submitting}>
		{submitting ? 'Saving…' : 'Save receipt'}
	</Button>
</ActionBar>
