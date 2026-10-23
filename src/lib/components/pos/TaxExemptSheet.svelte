<script lang="ts">
	// THE TAX-EXEMPT SHEET (tasks/bill-tax-override T-16): the cashier picks one of
	// the 0% rates the owner offered for tax-exempt bills and types who is exempt
	// and why. A modal, because it collects a reason (CLAUDE.md: modals are for
	// reason codes, approvals and errors only). It takes strings only and does no
	// money work: the page applies the choice through applyTaxOverride, which
	// cleans the reason with the server's own rule and refuses a short one — its
	// sentence comes back as `error`.
	import Icon from '../ui/Icon.svelte';
	import TillBanner from './TillBanner.svelte';
	import { KEY, KEY_CHOSEN, TILL_FIELD } from './keys';

	let {
		open,
		rates,
		current = null,
		error = '',
		onapply,
		onremove,
		oncancel
	}: {
		open: boolean;
		/** The offered rates, each with its label already written ("Exempt 0.00%"). */
		rates: { id: string; label: string }[];
		/** The bill's exemption, when it already has one. */
		current?: { rateId: string; reason: string } | null;
		/** The page's refusal, in words. */
		error?: string;
		onapply: (rateId: string, reason: string) => void;
		onremove: () => void;
		oncancel: () => void;
	} = $props();

	const uid = $props.id();
	let dialog = $state<HTMLDialogElement>();
	let rateId = $state<string | null>(null);
	let reason = $state('');

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			// Fresh each time it opens: the bill's current choice, or the only rate.
			rateId = current?.rateId ?? (rates.length === 1 ? rates[0].id : null);
			reason = current?.reason ?? '';
			dialog.showModal();
		}
		if (!open && dialog.open) dialog.close();
	});

	// A hint for the button only, counted in code points like the real rule; the
	// page's applyTaxOverride is what decides.
	const enough = $derived([...reason.trim()].length >= 3);
	const ready = $derived(rateId !== null && enough);
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="{uid}-h"
	onclose={() => {
		if (open) oncancel();
	}}
	class="bg-scrim m-0 h-dvh max-h-none w-full max-w-none border-0 p-3 backdrop:bg-transparent"
>
	{#if open}
		<form
			method="dialog"
			class="rounded-card border-line bg-raise shadow-raised mx-auto mt-12 flex max-w-lg flex-col gap-5 border p-5"
			onsubmit={(event) => {
				event.preventDefault();
				if (ready && rateId !== null) onapply(rateId, reason);
			}}
		>
			<div class="flex items-start gap-3">
				<h2 id="{uid}-h" class="text-title flex-1">Make this bill tax-exempt</h2>
				<button
					type="button"
					class="min-h-touch-min flex items-center gap-2 px-4 {KEY}"
					onclick={oncancel}
				>
					<Icon name="x" class="size-5" />Cancel
				</button>
			</div>

			<div class="flex flex-col gap-2">
				<p id="{uid}-rates" class="font-semibold">Exemption</p>
				<div role="radiogroup" aria-labelledby="{uid}-rates" class="grid gap-2 sm:grid-cols-2">
					{#each rates as rate (rate.id)}
						{@const on = rateId === rate.id}
						<button
							type="button"
							role="radio"
							aria-checked={on}
							class="min-h-touch flex items-center justify-center gap-2 px-3 {KEY} {KEY_CHOSEN}"
							onclick={() => (rateId = rate.id)}
						>
							{rate.label}
							{#if on}<Icon name="check-circle" class="size-6" />{/if}
						</button>
					{/each}
				</div>
			</div>

			<div class="flex flex-col gap-2">
				<label for="{uid}-reason" class="font-semibold">
					Who is exempt and why <span class="text-ink-2 font-normal">— shown on the receipt</span>
				</label>
				<input
					id="{uid}-reason"
					class={TILL_FIELD}
					maxlength="80"
					autocomplete="off"
					placeholder="For example: UNICEF, exemption letter 1234"
					bind:value={reason}
				/>
			</div>

			{#if error}
				<TillBanner tone="danger" live="alert">{error}</TillBanner>
			{/if}

			<div class="flex flex-wrap gap-3">
				<button
					type="submit"
					disabled={!ready}
					aria-describedby={ready ? undefined : `${uid}-why`}
					class="min-h-touch rounded-control border-accent bg-accent text-accent-ink disabled:border-control-line disabled:bg-disabled-bg disabled:text-disabled-ink flex-1 border px-5 font-semibold"
				>
					Remove the tax
				</button>
				{#if current}
					<button type="button" class="min-h-touch px-5 {KEY}" onclick={onremove}>
						Charge tax again
					</button>
				{/if}
			</div>
			{#if !ready}
				<p id="{uid}-why" class="text-ink-2 text-body">
					{rateId === null ? 'Choose an exemption' : 'Type who is exempt — at least 3 characters'}
				</p>
			{/if}
		</form>
	{/if}
</dialog>
