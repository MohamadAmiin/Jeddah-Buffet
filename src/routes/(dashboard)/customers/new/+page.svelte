<script lang="ts">
	// ADD A CUSTOMER. A plain form: the server validates, and a refusal hands the
	// typed values back so nothing is lost.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { Alert, Button, Card, Field, PageBody, PageHeader } from '$lib/components/ui';

	let { data, form } = $props();

	let submitting = $state(false);
	const kept = $derived(form?.values);
</script>

<svelte:head>
	<title>Add a customer · matcami</title>
</svelte:head>

<PageHeader crumbs={[{ label: 'Customers', href: resolve('/customers') }]} title="Add a customer" />

<PageBody>
	<Card>
		<form
			method="POST"
			action="?/create"
			class="flex flex-col gap-4"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
		>
			{#if form?.message}
				<Alert tone="danger">{form.message}</Alert>
			{/if}
			<div class="grid gap-4 md:grid-cols-2 md:items-start">
				<Field
					id="customer-name"
					name="name"
					label="Name"
					required
					maxlength={80}
					value={kept?.name ?? ''}
				/>
				<Field
					id="customer-phone"
					name="phone"
					label="Phone"
					required
					maxlength={32}
					inputmode="tel"
					value={kept?.phone ?? ''}
					hint="One customer per phone number."
				/>
				<Field
					id="customer-limit"
					name="creditLimit"
					label="Credit limit"
					inputmode="decimal"
					numeric
					value={kept?.creditLimit ?? ''}
					disabled={data.currency === null}
					hint={data.currency
						? `In ${data.currency.code}. Leave empty for no limit. The till refuses a bill that would pass it.`
						: 'Set the currency in Settings before entering a limit.'}
				/>
			</div>
			<div>
				<Button type="submit" variant="primary" disabled={submitting}>
					{submitting ? 'Saving…' : 'Add customer'}
				</Button>
			</div>
		</form>
	</Card>
</PageBody>
